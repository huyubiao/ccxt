use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::binance::{number, Binance, Endpoint};
use crate::markets::{bundle_candidate, bundled_coin, Cache, Exchange, Instrument, Kind, Markets, Snapshot};
use crate::now_ms;
use crate::research::{positive, Research};

const STEP: i64 = 300_000;
const BARS_PER_DAY: usize = 288;
const VOLATILITY_THRESHOLDS: [f64; 5] = [0.005, 0.01, 0.02, 0.04, 0.08];
const CAP_LIMITS: [f64; 7] = [30e6, 200e6, 1e9, 4.5e9, 15e9, 45e9, f64::INFINITY];
const CAP_LABELS: [&str; 7] = [
    "极度高风险",
    "很高风险",
    "高风险",
    "中风险",
    "低风险",
    "较稳定",
    "稳定",
];
const LONG: usize = 0;
const SHORT: usize = 1;
const BAND_WIDTH: f64 = 0.01;
const NEAR: f64 = 0.5;
const OLD_STOCK: f64 = 0.30;
const PREFERRED_EXIT: f64 = 0.60;
const HIGH_PROFIT_EXIT: f64 = 0.09;
const NEAR_EXIT: f64 = 0.01;
const DIRECTIONAL_TURNOVER: f64 = 0.65;
const ADD_LIMIT: f64 = 0.20;
const POSITION_ADD_LIMIT: f64 = 0.25;

struct Input {
    symbol: String,
    interest: Vec<Interest>,
    bars: Vec<Bar>,
    mark_price: f64,
    as_of: i64,
    capitalization: Option<Value>,
    margin_profile: Option<MarginProfile>,
    calibration: Arc<Calibration>,
}

#[derive(Clone, Copy, Deserialize)]
struct Interest {
    time: i64,
    quantity: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bar {
    time: i64,
    open: Option<f64>,
    high: f64,
    low: f64,
    close: f64,
    volume: Option<f64>,
    turnover_price: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarginProfile {
    max_leverage: f64,
    maintenance_rate: f64,
    notional_cap: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    brackets: Vec<MarginBracket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fetched_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarginBracket {
    floor: f64,
    cap: f64,
    max_leverage: f64,
    rate: f64,
    deduction: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Calibration {
    id: String,
    leveraged: Vec<Tier>,
    market_cap_slope: f64,
    volatility_slope: f64,
    position: PositionCalibration,
}

#[derive(Deserialize)]
struct Tier {
    leverage: f64,
    long: f64,
    short: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionCalibration {
    low_leverage_shares: Shares,
    collateral_multipliers: [f64; 3],
}

#[derive(Deserialize)]
struct Shares {
    long: [f64; 4],
    short: [f64; 4],
}

const DAY: i64 = 86_400_000;
pub const HISTORY_UNAVAILABLE: &str =
    "币安回看区间的未平仓量、标记价或成交量数据不完整，无法估算强平价。";
pub const MARGIN_UNAVAILABLE: &str = "暂未取得该合约完整的币安保证金档位，请稍后重试。";

pub enum LoadError {
    Upstream,
    History,
    Margin,
}

#[derive(Clone)]
struct Older {
    from: i64,
    before: i64,
    points: Vec<Interest>,
    bars: Vec<Bar>,
}

#[derive(Default)]
struct Margins {
    profiles: HashMap<String, MarginProfile>,
    next_attempt: i64,
}

pub struct Loader {
    markets: Arc<Markets>,
    research: Arc<Research>,
    profiles: Mutex<Margins>,
    capital: Cache<String, Option<Value>>,
    older: Cache<String, Older>,
    recent_interest: Cache<String, Vec<Interest>>,
    levels: Cache<String, Value>,
    calibration: Arc<Calibration>,
    slots: Arc<tokio::sync::Semaphore>,
}

impl Loader {
    pub fn new(markets: Arc<Markets>, research: Arc<Research>) -> crate::store::Result<Self> {
        let calibration =
            serde_json::from_str(include_str!("../../lib/binance-position-calibration.json"))?;
        Ok(Self {
            markets,
            research,
            profiles: Mutex::new(Margins::default()),
            capital: Cache::new(),
            older: Cache::new(),
            recent_interest: Cache::new(),
            levels: Cache::new(),
            calibration: Arc::new(calibration),
            slots: Arc::new(tokio::sync::Semaphore::new(2)),
        })
    }

    pub async fn levels(&self, pair: &Instrument) -> Result<Value, LoadError> {
        let entry = self.levels.entry(pair.id.clone()).await;
        let mut cache = entry.lock().await;
        if let Some(saved) = cache.as_ref().filter(|saved| saved.until > now_ms()) {
            return Ok(saved.value.clone());
        }
        let input = self.load(pair).await?;
        let slot = Arc::clone(&self.slots)
            .acquire_owned()
            .await
            .map_err(|_| LoadError::Upstream)?;
        let value = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            estimate(input)
        })
        .await
        .map_err(|_| LoadError::Upstream)?
        .map_err(|_| LoadError::History)?;
        *cache = Some(Snapshot {
            value: value.clone(),
            until: now_ms() + 60_000,
        });
        Ok(value)
    }

    pub async fn contract_levels(&self, symbol: &str) -> Result<Value, LoadError> {
        let pair = self.markets.instrument(Exchange::Binance, Kind::Futures, symbol)
            .await.map_err(|_| LoadError::Upstream)?;
        self.levels(&pair).await
    }

    async fn load(&self, pair: &Instrument) -> Result<Input, LoadError> {
        let binance = &self.markets.binance;
        let (points, mark, quote, capitalization, margin_profile, trades) = tokio::join!(
            self.recent_interest(&pair.id),
            binance.get::<Vec<Value>>(
                Endpoint::MarkKlines,
                json!({"symbol":pair.id,"interval":"5m","limit":578})
            ),
            binance.get::<Value>(Endpoint::PremiumIndex, json!({"symbol":pair.id})),
            self.capitalization(pair),
            self.margin_profile(&pair.id),
            binance.get::<Vec<Value>>(
                Endpoint::Klines,
                json!({"symbol":pair.id,"interval":"5m","limit":290})
            ),
        );
        let (points, mark, quote, trades) = (
            points?,
            mark.map_err(|_| LoadError::Upstream)?,
            quote.map_err(|_| LoadError::Upstream)?,
            trades.map_err(|_| LoadError::Upstream)?,
        );
        let margin_profile = margin_profile?;
        let now = now_ms();
        let as_of = quote["time"]
            .as_i64()
            .filter(|time| (now - 120_000..=now + 5_000).contains(time))
            .ok_or(LoadError::Upstream)?;
        let mark_price = positive(&quote["markPrice"])
            .filter(|_| quote["symbol"] == pair.id)
            .ok_or(LoadError::Upstream)?;
        let current = as_of.div_euclid(STEP) * STEP;
        let to = if points.iter().any(|point| point.time == current) {
            current
        } else {
            current - STEP
        };
        if !points.iter().any(|point| point.time == to) {
            return Err(LoadError::History);
        }
        let from = to - DAY;
        let before = points.first().ok_or(LoadError::History)?.time;
        let old = self.older_history(pair, from, before).await?;
        let mut bars = old.bars;
        let older_loaded = !bars.is_empty();
        bars.extend(
            mark_bars(&mark, &trades)
                .into_iter()
                .filter(|bar| !older_loaded || bar.time >= before),
        );
        let points = old
            .points
            .into_iter()
            .chain(points)
            .map(|point| (point.time, point))
            .collect::<HashMap<_, _>>();
        let interest = required_history(&points, &bars, from, to, pair.onboard_at, current)?;
        Ok(Input {
            symbol: pair.id.clone(),
            interest,
            bars,
            mark_price,
            as_of,
            capitalization,
            margin_profile: Some(margin_profile),
            calibration: Arc::clone(&self.calibration),
        })
    }

    async fn recent_interest(&self, symbol: &str) -> Result<Vec<Interest>, LoadError> {
        let entry = self.recent_interest.entry(symbol.to_owned()).await;
        let mut cache = entry.lock().await;
        if let Some(saved) = cache.as_ref().filter(|saved| saved.until > now_ms()) {
            return Ok(saved.value.clone());
        }
        let rows: Vec<Value> = self
            .markets
            .binance
            .get(
                Endpoint::OpenInterestHistory,
                json!({"symbol":symbol,"period":"5m","limit":289}),
            )
            .await
            .map_err(|_| LoadError::Upstream)?;
        let points = interests(&rows);
        *cache = Some(Snapshot {
            value: points.clone(),
            until: now_ms() + 15_000,
        });
        Ok(points)
    }

    async fn older_history(
        &self,
        pair: &Instrument,
        from: i64,
        before: i64,
    ) -> Result<Older, LoadError> {
        let entry = self.older.entry(pair.id.clone()).await;
        let mut cache = entry.lock().await;
        if let Some(saved) = cache.as_ref().filter(|saved| {
            saved.until > now_ms() && saved.value.from == from && saved.value.before == before
        }) {
            return Ok(saved.value.clone());
        }
        let listing = (pair.onboard_at + STEP - 1).div_euclid(STEP) * STEP;
        let start = listing.max(from);
        let (mut points, mut bars) = (Vec::new(), Vec::new());
        if start < before {
            let binance = &self.markets.binance;
            let mark_start = listing.max(start - DAY);
            let symbol = &pair.id;
            let (interest, mark, trades) = tokio::try_join!(
                history_pages(
                    binance,
                    symbol,
                    Endpoint::OpenInterestHistory,
                    start,
                    before,
                    500
                ),
                history_pages(
                    binance,
                    symbol,
                    Endpoint::MarkKlines,
                    mark_start,
                    before,
                    1_000
                ),
                history_pages(binance, symbol, Endpoint::Klines, start, before, 1_000),
            )?;
            points = interests(&interest);
            bars = mark_bars(&mark, &trades);
        }
        let value = Older {
            from,
            before,
            points,
            bars,
        };
        *cache = Some(Snapshot {
            value: value.clone(),
            until: now_ms() + STEP,
        });
        Ok(value)
    }

    async fn margin_profile(&self, symbol: &str) -> Result<MarginProfile, LoadError> {
        let now = now_ms();
        let mut profiles = self.profiles.lock().await;
        if let Some(profile) = profiles
            .profiles
            .get(symbol)
            .filter(|profile| profile.fetched_at.is_some_and(|at| now - at < 3_600_000))
        {
            return Ok(profile.clone());
        }
        if now >= profiles.next_attempt {
            let response = self
                .markets
                .http(
                    "https://www.binance.com",
                    "bapi/futures/v1/friendly/future/common/brackets",
                    &[],
                )
                .await;
            let now = now_ms();
            if let Ok(response) = response {
                if response["success"] == true {
                    profiles
                        .profiles
                        .retain(|_, profile| profile.fetched_at.is_some_and(|at| now - at < DAY));
                    profiles.profiles.extend(
                        response["data"]["brackets"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|row| {
                                Some((
                                    row["symbol"]
                                        .as_str()
                                        .filter(|symbol| !symbol.is_empty())?
                                        .to_owned(),
                                    read_margin(row, now)?,
                                ))
                            }),
                    );
                }
            }
            profiles.next_attempt = now + 60_000;
        }
        profiles
            .profiles
            .get(symbol)
            .filter(|profile| profile.fetched_at.is_some_and(|at| now_ms() - at < DAY))
            .cloned()
            .ok_or(LoadError::Margin)
    }

    async fn capitalization(&self, pair: &Instrument) -> Option<Value> {
        if pair.contract_type == "TRADIFI_PERPETUAL" {
            return None;
        }
        let entry = self.capital.entry(pair.id.clone()).await;
        let mut cache = entry.lock().await;
        let now = now_ms();
        if let Some(saved) = cache.as_ref().filter(|saved| saved.until > now) {
            return saved.value.clone();
        }
        let mut historical = self
            .research
            .daily_market_caps(pair, 361)
            .await
            .unwrap_or_default();
        if historical.is_empty() {
            let (a, b, c) = tokio::join!(
                self.research.daily_market_caps(pair, 181),
                self.research.daily_market_caps(pair, 61),
                self.research.daily_market_caps(pair, 31)
            );
            historical = a
                .unwrap_or_default()
                .into_iter()
                .chain(b.unwrap_or_default())
                .chain(c.unwrap_or_default())
                .collect();
        }
        let mut cap = median_cap(historical, "coingecko", now, pair.onboard_at);
        if cap
            .as_ref()
            .and_then(|cap| cap["windowDays"].as_i64())
            .unwrap_or(0)
            < 30
            && pair.base == pair.coin
            && bundled_coin(&pair.base).is_none()
            && bundle_candidate(&pair.base).is_none()
            && pair.base.bytes().take_while(u8::is_ascii_digit).count() < 3
        {
            let fallback: Vec<Value> = self
                .markets
                .binance
                .get(
                    Endpoint::OpenInterestHistory,
                    json!({"symbol":pair.id,"period":"1d","limit":30,"endTime":now}),
                )
                .await
                .unwrap_or_default();
            let rows = fallback
                .iter()
                .filter_map(|row| {
                    Some((
                        row["timestamp"].as_i64()?,
                        positive(&row["sumOpenInterestValue"])?
                            / positive(&row["sumOpenInterest"])?
                            * positive(&row["CMCCirculatingSupply"])?,
                    ))
                })
                .collect();
            if let Some(fallback) = median_cap(rows, "binance-cmc-proxy", now, pair.onboard_at)
                .filter(|fallback| {
                    fallback["samples"].as_u64().unwrap_or_default()
                        > cap
                            .as_ref()
                            .and_then(|cap| cap["samples"].as_u64())
                            .unwrap_or_default()
                })
            {
                cap = Some(fallback);
            }
        }
        let minutes = if cap.as_ref().is_some_and(|cap| cap["source"] == "coingecko") {
            360
        } else {
            15
        };
        *cache = Some(Snapshot {
            value: cap.clone(),
            until: now_ms() + minutes * 60_000,
        });
        cap
    }
}

fn read_margin(row: &Value, now: i64) -> Option<MarginProfile> {
    let mut brackets: Vec<_> = row["riskBrackets"]
        .as_array()?
        .iter()
        .map(|data| {
            Some(MarginBracket {
                floor: number(&data["bracketNotionalFloor"])?,
                cap: number(&data["bracketNotionalCap"])?,
                rate: number(&data["bracketMaintenanceMarginRate"])?,
                deduction: number(&data["cumFastMaintenanceAmount"])?,
                max_leverage: number(&data["maxOpenPosLeverage"])?,
            })
        })
        .collect::<Option<_>>()?;
    brackets.sort_by(|a, b| a.floor.total_cmp(&b.floor));
    let first = brackets.first()?;
    let mut end = 0.0;
    for row in &brackets {
        if row.floor != end
            || row.cap <= row.floor
            || !(0.0..1.0).contains(&row.rate)
            || row.deduction < 0.0
            || row.max_leverage < 1.0
            || row.max_leverage.fract() != 0.0
        {
            return None;
        }
        end = row.cap;
    }
    if first.rate >= 1.0 / first.max_leverage {
        return None;
    }
    Some(MarginProfile {
        max_leverage: first.max_leverage,
        maintenance_rate: first.rate,
        notional_cap: first.cap,
        brackets,
        fetched_at: Some(now),
    })
}

async fn history_pages(
    binance: &Binance,
    symbol: &str,
    endpoint: Endpoint,
    from: i64,
    to: i64,
    limit: i64,
) -> Result<Vec<Value>, LoadError> {
    let mut rows = Vec::new();
    for start in (from..to).step_by((limit * STEP) as usize) {
        let end = to.min(start + limit * STEP);
        let mut params =
            json!({"symbol":symbol,"startTime":start,"endTime":end-1,"limit":(end-start)/STEP});
        let interval = if matches!(endpoint, Endpoint::OpenInterestHistory) {
            "period"
        } else {
            "interval"
        };
        params[interval] = json!("5m");
        rows.extend(
            binance
                .get::<Vec<Value>>(endpoint, params)
                .await
                .map_err(|_| LoadError::Upstream)?,
        );
    }
    Ok(rows)
}

fn interests(rows: &[Value]) -> Vec<Interest> {
    let mut output: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            Some(Interest {
                time: row["timestamp"].as_i64()?,
                quantity: number(&row["sumOpenInterest"]).filter(|value| *value >= 0.0)?,
            })
        })
        .collect();
    output.sort_by_key(|point| point.time);
    output
}

fn mark_bars(mark: &[Value], trades: &[Value]) -> Vec<Bar> {
    let traded: HashMap<_, _> = trades
        .iter()
        .filter_map(|row| {
            let volume = number(&row[5]);
            let turnover_price = volume
                .filter(|volume| *volume > 0.0)
                .zip(number(&row[7]))
                .map(|(volume, turnover)| turnover / volume)
                .filter(|price| price.is_finite() && *price > 0.0);
            Some((row[0].as_i64()?, (volume, turnover_price)))
        })
        .collect();
    mark.iter()
        .filter_map(|row| {
            let time = row[0].as_i64()?;
            let (open, high, low, close) = (
                number(&row[1])?,
                number(&row[2])?,
                number(&row[3])?,
                number(&row[4])?,
            );
            let (volume, turnover_price) = traded.get(&time).copied().unwrap_or_default();
            if low <= 0.0 || !(low..=high).contains(&open) || !(low..=high).contains(&close) {
                return None;
            }
            Some(Bar {
                time,
                open: Some(open),
                high,
                low,
                close,
                volume,
                turnover_price,
            })
        })
        .collect()
}

fn required_history(
    points: &HashMap<i64, Interest>,
    bars: &[Bar],
    from: i64,
    to: i64,
    onboard: i64,
    current: i64,
) -> Result<Vec<Interest>, LoadError> {
    let listing = (onboard + STEP - 1).div_euclid(STEP) * STEP;
    let mut start = from.max(listing);
    if listing > from {
        while start < to && !points.contains_key(&start) {
            start += STEP;
        }
    }
    if start >= to {
        return Err(LoadError::History);
    }
    let interest = (start..=to)
        .step_by(STEP as usize)
        .map(|time| points.get(&time).copied())
        .collect::<Option<Vec<_>>>()
        .ok_or(LoadError::History)?;
    let bars: HashMap<_, _> = bars.iter().map(|bar| (bar.time, bar)).collect();
    if (start..current).step_by(STEP as usize).any(|time| {
        bars.get(&time)
            .is_none_or(|bar| time < to && bar.volume.is_none_or(|volume| volume < 0.0))
    }) {
        return Err(LoadError::History);
    }
    Ok(interest)
}

fn median_cap(rows: Vec<(i64, f64)>, source: &str, now: i64, onboard: i64) -> Option<Value> {
    let end = now.div_euclid(DAY) * DAY;
    let mut daily = BTreeMap::<i64, (i64, f64)>::new();
    for (time, cap) in rows
        .into_iter()
        .filter(|(time, cap)| (0..=end).contains(time) && cap.is_finite() && *cap > 0.0)
    {
        let day = time.div_euclid(DAY) * DAY;
        if daily.get(&day).is_none_or(|(prior, _)| time >= *prior) {
            daily.insert(day, (time, cap));
        }
    }
    let through = *daily.last_key_value()?.0;
    let summarize = |days, mut caps: Vec<f64>| {
        caps.sort_by(f64::total_cmp);
        let samples = caps.len();
        let median = (caps[(samples - 1) / 2] + caps[samples / 2]) / 2.0;
        json!({"medianUsd":median,"source":source,"windowDays":days,"samples":samples,"through":through})
    };
    if through >= end - DAY {
        let windows: &[i64] = if source == "binance-cmc-proxy" {
            &[30, 7]
        } else {
            &[360, 180, 60, 30]
        };
        for &days in windows {
            let caps: Vec<_> = daily
                .range(through - (days - 1) * DAY..)
                .map(|(_, (_, cap))| *cap)
                .collect();
            if caps.len() == days as usize {
                return Some(summarize(days, caps));
            }
        }
    }
    if onboard <= 0 || onboard > now || now - onboard >= 30 * DAY {
        return None;
    }
    let recent: Vec<_> = daily
        .iter()
        .filter(|(_, (time, _))| *time >= onboard)
        .collect();
    let first = *recent.first()?.0;
    Some(summarize(
        (through - first) / DAY + 1,
        recent.iter().map(|(_, (_, cap))| *cap).collect(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Weight {
    leverage: f64,
    long: f64,
    short: f64,
    maintenance_rate: f64,
    effective_margin_rate: f64,
}

struct Position {
    entry: f64,
    leverage: f64,
    margin_rate: f64,
    margin_per_unit: f64,
    account_quantity: f64,
    price: f64,
    quantity: f64,
    opened_at: i64,
    has_added: bool,
}

struct Weighting<'a> {
    profiles: [Vec<Weight>; 6],
    ranges: HashMap<i64, [usize; 5]>,
    cap_index: usize,
    cap_factor: f64,
    input: &'a Input,
}

impl<'a> Weighting<'a> {
    fn new(input: &'a Input, bars: &BTreeMap<i64, Bar>) -> Self {
        let cap_index = input
            .capitalization
            .as_ref()
            .and_then(|cap| cap["medianUsd"].as_f64())
            .and_then(|cap| CAP_LIMITS.iter().position(|limit| cap < *limit))
            .unwrap_or(if matches!(input.symbol.as_str(), "BTCUSDT" | "ETHUSDT") {
                6
            } else {
                3
            });
        let cap_factor = (input.calibration.market_cap_slope * (cap_index as f64 - 3.0)).exp();
        let profiles = std::array::from_fn(|level| {
            let factor = cap_factor * (input.calibration.volatility_slope * level as f64).exp();
            weights(factor, &input.calibration, input.margin_profile.as_ref())
        });
        Self {
            profiles,
            ranges: ranges(bars),
            cap_index,
            cap_factor,
            input,
        }
    }

    fn level(&self, time: i64) -> usize {
        self.ranges
            .get(&time)
            .and_then(|counts| counts.iter().rposition(|count| *count >= 5))
            .map_or(0, |index| index + 1)
    }

    fn details(&self, time: i64) -> Value {
        let level = self.level(time);
        let factor = (self.input.calibration.volatility_slope * level as f64).exp();
        let history = self.input.capitalization.is_some();
        json!({"capitalization":self.input.capitalization,"marketCapBand":{"belowUsd":CAP_LIMITS[self.cap_index],
            "label":if history {CAP_LABELS[self.cap_index]} else {"市值未知"},"factor":self.cap_factor,"index":self.cap_index,
            "source":if history {"history"} else {"fallback"}},"factor":self.cap_factor * factor,"volatilityFactor":factor,
            "weights":self.profiles[level],"marginProfile":self.input.margin_profile,"volatilityLevel":level+1,
            "volatilityCounts":self.ranges.get(&time),"thresholds":VOLATILITY_THRESHOLDS})
    }
}

fn ranges(bars: &BTreeMap<i64, Bar>) -> HashMap<i64, [usize; 5]> {
    let mut recent = VecDeque::new();
    let mut counts = [0; 5];
    let mut result = HashMap::new();
    let mut previous = None;
    for bar in bars.values() {
        let Some(open) = bar.open.filter(|open| (bar.low..=bar.high).contains(open)) else {
            continue;
        };
        if bar.low <= 0.0 || bar.time % STEP != 0 {
            continue;
        }
        if previous != Some(bar.time - STEP) {
            recent.clear();
            counts.fill(0);
        }
        previous = Some(bar.time);
        let range = (bar.high - bar.low) / open;
        let band = VOLATILITY_THRESHOLDS
            .iter()
            .filter(|threshold| range - **threshold > f64::EPSILON)
            .count();
        if recent.len() == BARS_PER_DAY {
            let expired = recent.pop_front().unwrap_or_default();
            for count in counts.iter_mut().take(expired) {
                *count -= 1;
            }
        }
        recent.push_back(band);
        for count in counts.iter_mut().take(band) {
            *count += 1;
        }
        if recent.len() == BARS_PER_DAY {
            result.insert(bar.time + STEP, counts);
        }
    }
    result
}

fn weights(factor: f64, calibration: &Calibration, profile: Option<&MarginProfile>) -> Vec<Weight> {
    let long_remaining = 1.0
        - calibration
            .leveraged
            .iter()
            .map(|weight| weight.long * factor)
            .sum::<f64>();
    let short_remaining = 1.0
        - calibration
            .leveraged
            .iter()
            .map(|weight| weight.short * factor)
            .sum::<f64>();
    let mut tiers: Vec<_> = (0..4)
        .map(|index| {
            (
                (index + 1) as f64,
                calibration.position.low_leverage_shares.long[index] * long_remaining,
                calibration.position.low_leverage_shares.short[index] * short_remaining,
            )
        })
        .collect();
    tiers.extend(
        calibration
            .leveraged
            .iter()
            .map(|tier| (tier.leverage, tier.long * factor, tier.short * factor)),
    );
    let exchange_ceiling = profile.map_or(20.0, |profile| profile.max_leverage);
    let ceiling = if exchange_ceiling < 50.0 {
        exchange_ceiling.min(20.0)
    } else {
        50.0
    };
    if tiers.iter().any(|(leverage, ..)| *leverage > ceiling) {
        let long = tiers
            .iter()
            .filter(|(leverage, ..)| *leverage >= ceiling)
            .map(|(_, long, _)| long)
            .sum();
        let short = tiers
            .iter()
            .filter(|(leverage, ..)| *leverage >= ceiling)
            .map(|(_, _, short)| short)
            .sum();
        tiers.retain(|(leverage, ..)| *leverage < ceiling);
        tiers.push((ceiling, long, short));
    }
    tiers
        .into_iter()
        .map(|(leverage, long, short)| {
            let multiplier = calibration.position.collateral_multipliers[if leverage <= 4.0 {
                0
            } else if leverage <= 10.0 {
                1
            } else {
                2
            }];
            let initial = 1.0 / leverage;
            let maintenance_rate = profile.map_or(0.0, |profile| profile.maintenance_rate);
            let effective_margin_rate = match profile {
                Some(profile) if multiplier != 1.0 && leverage != 1.0 => {
                    let notional = representative_notional(leverage, profile);
                    let bracket = profile
                        .brackets
                        .iter()
                        .find(|row| (row.floor..=row.cap).contains(&notional));
                    let maintenance = bracket.map_or(maintenance_rate, |row| {
                        (row.rate - row.deduction / notional).max(0.0)
                    });
                    (maintenance + multiplier * (initial - maintenance).max(0.0)).min(1.0)
                }
                _ => initial,
            };
            Weight {
                leverage,
                long,
                short,
                maintenance_rate,
                effective_margin_rate,
            }
        })
        .collect()
}

fn representative_notional(leverage: f64, profile: &MarginProfile) -> f64 {
    let eligible = profile
        .brackets
        .iter()
        .rfind(|bracket| bracket.max_leverage >= leverage);
    (2.0 * profile.notional_cap)
        .min(eligible.map_or(profile.notional_cap, |bracket| bracket.cap) * 0.95)
}

fn account_size(entry: f64, leverage: f64, profile: Option<&MarginProfile>) -> f64 {
    profile.map_or(1.0, |profile| {
        representative_notional(leverage, profile) / entry
    })
}

fn liquidation_price(
    entry: f64,
    sign: f64,
    margin: f64,
    account: f64,
    profile: Option<&MarginProfile>,
) -> f64 {
    if let Some(profile) = profile {
        for row in &profile.brackets {
            let price =
                (entry + sign * (margin + row.deduction / account)) / (1.0 + sign * row.rate);
            if price <= 0.0 || (row.floor..=row.cap).contains(&(account * price)) {
                return price;
            }
        }
    }
    (entry + sign * margin) / (1.0 + sign * profile.map_or(0.0, |profile| profile.maintenance_rate))
}

fn add_positions(
    positions: &mut [Position],
    mark: f64,
    sign: f64,
    net: f64,
    profile: Option<&MarginProfile>,
) -> f64 {
    let mut candidates = Vec::new();
    let mut eligible = 0.0;
    let mut tranche = HashMap::new();
    for (index, position) in positions.iter().enumerate() {
        if position.has_added
            || position.quantity <= 0.0
            || sign * (mark - position.entry) < (position.price - position.entry).abs() * NEAR
        {
            continue;
        }
        let price = tranche
            .entry(position.leverage.to_bits())
            .or_insert_with(|| {
                liquidation_price(
                    mark,
                    sign,
                    mark * position.margin_rate,
                    account_size(mark, position.leverage, profile),
                    profile,
                )
            });
        if sign * (*price - position.price) <= 0.0 {
            continue;
        }
        candidates.push(index);
        eligible += position.quantity;
    }
    if eligible == 0.0 {
        return net;
    }
    let allocated = (net * ADD_LIMIT).min(eligible * POSITION_ADD_LIMIT);
    for index in candidates {
        let position = &mut positions[index];
        let increment = allocated * (position.quantity / eligible);
        let total = position.quantity + increment;
        let tranche_margin = mark * position.margin_rate;
        position.entry = (position.entry * position.quantity + mark * increment) / total;
        position.margin_per_unit =
            (position.margin_per_unit * position.quantity + tranche_margin * increment) / total;
        position.account_quantity *= total / position.quantity;
        position.quantity += increment;
        position.price = liquidation_price(
            position.entry,
            sign,
            position.margin_per_unit,
            position.account_quantity,
            profile,
        );
        position.has_added = true;
    }
    net - allocated
}

fn open_positions(
    positions: &mut Vec<Position>,
    side: usize,
    entry: f64,
    size: f64,
    time: i64,
    weights: &[Weight],
    profile: Option<&MarginProfile>,
) {
    if size <= 0.0 {
        return;
    }
    let sign = if side == LONG { -1.0 } else { 1.0 };
    for weight in weights {
        let share = if side == LONG {
            weight.long
        } else {
            weight.short
        };
        if share <= 0.0 {
            continue;
        }
        let account = account_size(entry, weight.leverage, profile);
        let margin = entry * weight.effective_margin_rate;
        positions.push(Position {
            entry,
            leverage: weight.leverage,
            margin_rate: weight.effective_margin_rate,
            margin_per_unit: margin,
            account_quantity: account,
            quantity: size * share,
            opened_at: time,
            has_added: false,
            price: liquidation_price(entry, sign, margin, account, profile),
        });
    }
}

fn reduce(
    positions: &mut [Position],
    indices: &[usize],
    requested: f64,
    unknown: f64,
) -> (f64, f64) {
    if requested <= 0.0 {
        return (requested, unknown);
    }
    let stock = indices
        .iter()
        .fold(unknown, |sum, index| sum + positions[*index].quantity);
    let exited = requested.min(stock);
    if exited <= 0.0 {
        return (requested, unknown);
    }
    let retention = 1.0 - exited / stock;
    for index in indices {
        positions[*index].quantity *= retention;
    }
    (requested - exited, unknown * retention)
}

fn ranked(
    positions: &mut [Position],
    mut group: Vec<(f64, usize)>,
    mark: f64,
    mut requested: f64,
) -> f64 {
    if requested <= 0.0 {
        return 0.0;
    }
    let distance = |index: usize| {
        if positions[index].price > 0.0 {
            (mark - positions[index].price).abs()
        } else {
            f64::INFINITY
        }
    };
    group.sort_by(|(first_rank, first), (second_rank, second)| {
        first_rank
            .total_cmp(second_rank)
            .then_with(|| distance(*second).total_cmp(&distance(*first)))
    });
    for (_, index) in group {
        let quantity = positions[index].quantity.min(requested);
        positions[index].quantity -= quantity;
        requested -= quantity;
        if requested <= 0.0 {
            return 0.0;
        }
    }
    requested
}

fn exit_positions(
    positions: &mut [Position],
    sign: f64,
    mark: f64,
    interest: f64,
    net: f64,
    extra: f64,
    exit_price: f64,
) {
    let net_budget = net.min(interest);
    let extra_budget = extra.min(interest - net_budget);
    if net_budget <= 0.0 && extra_budget <= 0.0 {
        return;
    }
    let mut near = Vec::new();
    let mut available = Vec::new();
    let mut profitable = Vec::new();
    let mut tracked = 0.0;
    for (index, position) in positions.iter().enumerate() {
        tracked += position.quantity;
        let distance = sign * (mark - position.price);
        if sign * (mark - position.entry) < 0.0
            && position.price > 0.0
            && distance > 0.0
            && distance <= (position.entry - position.price).abs() * NEAR
        {
            near.push(index);
        } else {
            available.push(index);
            if net_budget > 0.0 && sign * (mark - position.entry) > 0.0 {
                profitable.push(index);
            }
        }
    }
    let mut unknown = (interest - tracked).max(0.0);
    if net_budget > 0.0 {
        let (remaining, _) = reduce(positions, &profitable, net_budget, 0.0);
        let (remaining, next_unknown) = reduce(positions, &available, remaining, unknown);
        unknown = next_unknown;
        if remaining > 0.0 {
            reduce(positions, &near, remaining, 0.0);
        }
    }
    if extra_budget <= 0.0 {
        return;
    }
    let old_stock = extra_budget * OLD_STOCK;
    let old_budget = (old_stock - unknown).max(0.0);
    unknown -= unknown.min(old_stock);
    let (mut oldest, mut preferred, mut high_profit) = (Vec::new(), Vec::new(), Vec::new());
    for index in available {
        let position = &positions[index];
        if position.quantity <= 0.0 {
            continue;
        }
        let gain = sign * (exit_price - position.entry) / position.entry;
        preferred.push((gain.abs(), index));
        if gain > 0.0 {
            high_profit.push((-gain, index));
        }
        if old_budget > 0.0 {
            oldest.push((position.opened_at as f64, index));
        }
    }
    let mut preferred_budget = extra_budget * PREFERRED_EXIT;
    preferred_budget += ranked(
        positions,
        high_profit,
        mark,
        extra_budget * HIGH_PROFIT_EXIT,
    );
    preferred_budget += reduce(positions, &near, extra_budget * NEAR_EXIT, 0.0).0;
    preferred_budget += ranked(positions, oldest, mark, old_budget);
    let remaining = ranked(positions, preferred, mark, preferred_budget) - unknown;
    if remaining > 0.0 {
        reduce(positions, &near, remaining, 0.0);
    }
}

fn apply_change(
    positions: &mut [Vec<Position>; 2],
    previous: Interest,
    point: Interest,
    bar: Bar,
    weights: &[Weight],
    profile: Option<&MarginProfile>,
) {
    let mut liquidated = [0.0; 2];
    for (side, positions) in positions.iter_mut().enumerate() {
        positions.retain(|position| {
            if position.quantity <= 0.0 {
                return false;
            }
            let survives = if side == LONG {
                bar.low > position.price
            } else {
                bar.high < position.price
            };
            if !survives {
                liquidated[side] += position.quantity;
            }
            survives
        });
    }
    if point.quantity == 0.0 {
        positions.iter_mut().for_each(Vec::clear);
        return;
    }
    let change = point.quantity - previous.quantity;
    let excess = bar
        .volume
        .filter(|volume| *volume >= change.abs())
        .map_or(0.0, |volume| volume - change.abs());
    if change == 0.0 && excess == 0.0 {
        return;
    }
    let paired = excess * 0.50;
    let turnover = excess - paired;
    let open = bar.open.unwrap_or(bar.close);
    let long_share = if bar.close > open {
        DIRECTIONAL_TURNOVER
    } else if bar.close < open {
        1.0 - DIRECTIONAL_TURNOVER
    } else {
        0.5
    };
    let long_turnover = turnover * long_share;
    let pop = previous.quantity.min(point.quantity);
    let average = (previous.quantity + point.quantity) / 2.0;
    let net_increase = change.max(0.0);
    let net_decrease = (-change).max(0.0);
    let exit_rate = ((net_decrease + paired / 2.0) - net_decrease) / average;
    let after_paired = pop * (-exit_rate).exp();
    let paired_replacement = pop * -(-exit_rate).exp_m1();
    let price = bar.turnover_price.unwrap_or(bar.close);
    for (side, positions) in positions.iter_mut().enumerate() {
        let turnover = if side == LONG {
            long_turnover
        } else {
            turnover - long_turnover
        };
        let replacement = after_paired * -(-turnover / average).exp_m1();
        let forced = liquidated[side];
        let net_exits = (net_decrease - forced).max(0.0);
        let paired_exits = (paired_replacement - (forced - net_decrease).max(0.0)).max(0.0);
        let turnover_exits =
            (replacement - (forced - net_decrease - paired_replacement).max(0.0)).max(0.0);
        let extra = paired_exits + turnover_exits;
        let exit = if extra > 0.0 {
            bar.close + (price - bar.close) * (turnover_exits / extra)
        } else {
            bar.close
        };
        let sign = if side == LONG { 1.0 } else { -1.0 };
        exit_positions(
            positions,
            sign,
            bar.close,
            (previous.quantity - forced).max(0.0),
            net_exits,
            extra,
            exit,
        );
        let new = if net_increase > 0.0 {
            add_positions(positions, bar.close, -sign, net_increase, profile)
        } else {
            0.0
        };
        if price == bar.close {
            open_positions(
                positions,
                side,
                bar.close,
                new + paired_replacement + replacement,
                point.time,
                weights,
                profile,
            );
        } else {
            open_positions(
                positions,
                side,
                bar.close,
                new + paired_replacement,
                point.time,
                weights,
                profile,
            );
            open_positions(
                positions,
                side,
                price,
                replacement,
                point.time,
                weights,
                profile,
            );
        }
    }
}

fn estimate(input: Input) -> Result<Value, &'static str> {
    if input.interest.len() > 1_000
        || input.bars.len() > 2_000
        || input.calibration.leveraged.len() > 20
        || input
            .margin_profile
            .as_ref()
            .is_some_and(|profile| profile.brackets.len() > 100)
        || input.mark_price <= 0.0
    {
        return Err("Invalid liquidation model inputs.");
    }
    let bars: BTreeMap<_, _> = input.bars.iter().map(|bar| (bar.time, *bar)).collect();
    let weighting = Weighting::new(&input, &bars);
    let points: Vec<_> = input
        .interest
        .iter()
        .filter(|point| point.time <= input.as_of)
        .copied()
        .collect();
    if points.len() < 2 || input.as_of.saturating_sub(points.last().unwrap().time) > STEP * 2 {
        return Err("Recent mark price and open interest data are incomplete.");
    }
    let first = points[0];
    let last = *points.last().unwrap();
    let mut positions = [Vec::new(), Vec::new()];
    for points in points.windows(2) {
        let (previous, next) = (points[0], points[1]);
        let bar = bars
            .get(&previous.time)
            .copied()
            .filter(|_| next.time.saturating_sub(previous.time) == STEP)
            .ok_or("A liquidation model input interval is missing.")?;
        apply_change(
            &mut positions,
            previous,
            next,
            bar,
            &weighting.profiles[weighting.level(next.time)],
            input.margin_profile.as_ref(),
        );
    }
    let (low, high) = input
        .bars
        .iter()
        .filter(|bar| (last.time..=input.as_of).contains(&bar.time))
        .fold((input.mark_price, input.mark_price), |(low, high), bar| {
            (low.min(bar.low), high.max(bar.high))
        });
    let (levels, covered, triggers) = bands(positions, input.mark_price, last.quantity, low, high);
    let now = input.as_of.div_euclid(STEP) * STEP;
    let scenarios: Vec<_> = weighting.profiles[weighting.level(now)]
        .iter()
        .map(|weight| weight.leverage)
        .collect();
    Ok(
        json!({"exchange":"binance","symbol":input.symbol,"model":"open-interest-weighted-leverage","calibrationId":input.calibration.id,
        "amountBasis":"modeled-notional","validationStatus":"reference-calibrated","asOf":input.as_of,"markPrice":input.mark_price,
        "interestFrom":first.time,"interestThrough":last.time,"lookbackMs":last.time-first.time,"intervalMs":STEP,
        "coverage":{"openInterestQuantity":last.quantity,"longQuantity":covered[LONG],"shortQuantity":covered[SHORT]},
        "bandWidthPercent":BAND_WIDTH*100.0,"leverageScenarios":scenarios,"leverageWeighting":weighting.details(now),
        "positionAddScenario":{"adverseDistanceFraction":NEAR,"maxNetIncreaseFraction":ADD_LIMIT,"maxPositionIncreaseFraction":POSITION_ADD_LIMIT},
        "positionExitScenario":{"directionalTurnoverShare":DIRECTIONAL_TURNOVER,"nearLiquidationDistanceFraction":NEAR,"preferredExitShare":PREFERRED_EXIT,
            "oldStockExitShare":OLD_STOCK,"highProfitExitShare":HIGH_PROFIT_EXIT,"nearLiquidationExitShare":NEAR_EXIT},
        "levels":levels,"triggers":{"long":triggers[LONG],"short":triggers[SHORT]}}),
    )
}

fn bands(
    positions: [Vec<Position>; 2],
    mark: f64,
    interest: f64,
    low: f64,
    high: f64,
) -> (Vec<Value>, [f64; 2], [Vec<[f64; 2]>; 2]) {
    let width = mark * BAND_WIDTH;
    let mut buckets = HashMap::new();
    let mut covered = [0.0; 2];
    let mut triggers = [Vec::<[f64; 2]>::new(), Vec::new()];
    for (side, positions) in positions.into_iter().enumerate() {
        let mut indices: HashMap<u64, usize> = HashMap::new();
        for position in positions {
            let (price, quantity) = (position.price, position.quantity);
            if quantity <= 0.0
                || price <= 0.0
                || (if side == LONG {
                    price >= low
                } else {
                    price <= high
                })
            {
                continue;
            }
            covered[side] += quantity;
            if let Some(index) = indices.get(&price.to_bits()) {
                triggers[side][*index][1] += quantity;
            } else {
                indices.insert(price.to_bits(), triggers[side].len());
                triggers[side].push([price, quantity]);
            }
            let key = ((price - mark) / width).floor() as i32;
            let entry = buckets.entry(key).or_insert((0.0, 0.0));
            entry.0 += quantity;
            entry.1 += quantity * price;
        }
    }
    let max_notional = buckets
        .values()
        .map(|(_, amount)| *amount)
        .fold(0.0_f64, f64::max);
    let mut buckets: Vec<_> = buckets.into_iter().collect();
    buckets.sort_by_key(|(bucket, _)| ((2 * i64::from(*bucket) + 1).abs(), *bucket));
    let mut total = [0.0; 2];
    let mut levels: Vec<_> = buckets.into_iter().map(|(bucket,(quantity,notional))| {
        let price = notional / quantity;
        let side = if bucket < 0 {LONG} else {SHORT};
        let share = if interest > 0.0 {quantity / interest} else {0.0};
        let risk = if share >= 0.06 {"extreme"} else if share >= 0.03 {"high"} else if share >= 0.0025 {"elevated"} else {"low"};
        total[side] += notional;
        let distance = (price / mark - 1.0) * 100.0;
        let strength = notional / max_notional * 100.0;
        (strength, distance.abs(), json!({"side":if side == LONG {"long"} else {"short"},"price":price,"distancePercent":distance,
            "lowerPrice":(mark + f64::from(bucket) * width).max(0.0),"upperPrice":mark + (f64::from(bucket)+1.0) * width,
            "estimatedLiquidationUsdt":notional,"cumulativeEstimatedLiquidationUsdt":total[side],"strength":strength,"openInterestShare":share,"riskLevel":risk}))
    }).collect();
    levels.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.total_cmp(&b.1)));
    (
        levels.into_iter().map(|(_, _, value)| value).collect(),
        covered,
        triggers,
    )
}
