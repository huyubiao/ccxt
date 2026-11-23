use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};

use crate::binance::{number, Endpoint, VOLUME_DELAY_MS};
use crate::markets::{Exchange, Instrument, Kind, MarketError, Markets, Snapshot, SPOT};
use crate::now_ms;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
const WEEK: i64 = 7 * DAY;
const SHORT_WINDOWS: [(&str, i64); 3] = [("5s", 5_000), ("30s", 30_000), ("1m", MINUTE)];

#[derive(Clone, Copy, Default)]
struct Turnover {
    buy: f64,
    sell: f64,
}

impl Turnover {
    fn total(self) -> f64 {
        self.buy + self.sell
    }
}

struct Block {
    start: i64,
    end: i64,
    step: i64,
    amounts: HashMap<i64, Turnover>,
}

#[derive(Serialize)]
struct Trade {
    id: i64,
    time: i64,
    amount: f64,
    side: Option<&'static str>,
}

struct Seed {
    trades: Vec<Trade>,
    covered_from: Option<i64>,
}

impl Seed {
    fn response(&self, end: i64) -> Value {
        let mut response = json!({"asOf":end,"trades":self.trades,"rates":null});
        if let Some(start) = self.covered_from {
            response["coveredFrom"] = json!(start);
        }
        response
    }
}

pub async fn response(
    markets: &Markets,
    pair: &Instrument,
    view: Option<&str>,
) -> Result<Value, MarketError> {
    let short_end = now_ms() - VOLUME_DELAY_MS;
    match view {
        Some("rates") => return Ok(json!({"rates":null})),
        Some("recent") => {
            return seed(markets, pair, short_end)
                .await
                .map(|seed| seed.response(short_end))
        }
        _ => {}
    }
    let history_only = view == Some("history");
    let okx = pair.exchange == Some(Exchange::Okx);
    let total_only = okx || pair.kind == Kind::Alpha;
    let end = floor(short_end, MINUTE);
    let last_hour = floor(end, HOUR);
    let first_day_hour = ceil(end - DAY, HOUR);
    let first_week_hour = ceil(end - WEEK, HOUR);
    let short = async {
        if history_only {
            Vec::new()
        } else {
            short_windows(
                seed(markets, pair, short_end).await.ok().as_ref(),
                short_end,
                pair.kind == Kind::Alpha,
            )
        }
    };
    let okx_windows = async {
        if okx && pair.kind == Kind::Futures {
            okx_contract_windows(markets, &pair.id, end).await
        } else {
            HashMap::new()
        }
    };
    let multiple = async {
        if history_only && pair.kind == Kind::Futures {
            Some(volume_multiple(markets, pair, now_ms()).await)
        } else {
            None
        }
    };
    let (recent, older, day_edge, week_edge, mut windows, mut contract_windows, multiple) = tokio::join!(
        block(markets, pair, end - HOUR, end, MINUTE, false),
        block(markets, pair, first_week_hour, last_hour, HOUR, okx),
        block(markets, pair, end - DAY, first_day_hour, MINUTE, okx),
        block(markets, pair, end - WEEK, first_week_hour, MINUTE, okx),
        short,
        okx_windows,
        multiple,
    );
    let (recent, older, day_edge, week_edge) = (recent?, older?, day_edge?, week_edge?);
    if okx && history_only {
        windows.push(window(
            "1m",
            sum(&[&recent], end - MINUTE, pair.onboard_at),
            true,
        ));
    }
    for (period, start, blocks) in [
        ("5m", end - 5 * MINUTE, vec![&recent]),
        ("1h", end - HOUR, vec![&recent]),
        ("24h", end - DAY, vec![&day_edge, &older, &recent]),
        ("7d", end - WEEK, vec![&week_edge, &older, &recent]),
    ] {
        let value = contract_windows.remove(period).unwrap_or_else(|| {
            let totals = if period == "24h" || period == "7d" {
                let tail = Block {
                    start: last_hour,
                    end,
                    step: MINUTE,
                    amounts: recent.amounts.clone(),
                };
                sum(&[blocks[0], blocks[1], &tail], start, pair.onboard_at)
            } else {
                sum(&blocks, start, pair.onboard_at)
            };
            window(period, totals, total_only)
        });
        windows.push(value);
    }
    let mut result = json!({"symbol":pair.id,"asOf":end,"shortAsOf":short_end,"convertedFrom":null,"windows":windows});
    if let Some(multiple) = multiple {
        result["volumeMultiple"] = json!(multiple);
    }
    Ok(result)
}

async fn block(
    markets: &Markets,
    pair: &Instrument,
    start: i64,
    end: i64,
    step: i64,
    tolerate_failure: bool,
) -> Result<Block, MarketError> {
    let mut block = Block {
        start,
        end,
        step,
        amounts: HashMap::new(),
    };
    if start >= end || end <= pair.onboard_at {
        return Ok(block);
    }
    let fetched = candles(markets, pair, start, end, step).await;
    if let Ok(amounts) = fetched {
        block.amounts = amounts;
    } else if !tolerate_failure {
        fetched?;
    }
    Ok(block)
}

async fn candles(
    markets: &Markets,
    pair: &Instrument,
    start: i64,
    end: i64,
    step: i64,
) -> Result<HashMap<i64, Turnover>, MarketError> {
    let count = (end - start) / step;
    if pair.exchange == Some(Exchange::Okx) {
        let mut output = HashMap::new();
        let older = step == MINUTE && start < now_ms() - 23 * HOUR;
        let path = if older || step == DAY {
            "market/history-candles"
        } else {
            "market/candles"
        };
        let bar = match step {
            DAY => "1Dutc",
            HOUR => "1H",
            _ => "1m",
        };
        let page = if older { 100 } else { 300 };
        let mut before = end - 1;
        for page_index in 0..(count + page - 1) / page {
            let limit = page.min(count - page_index * page).to_string();
            let after = before.to_string();
            let rows = markets
                .okx(
                    path,
                    &[
                        ("instId", &pair.id),
                        ("bar", bar),
                        ("after", &after),
                        ("limit", &limit),
                    ],
                )
                .await?;
            for row in &rows {
                if row[8] == "1" {
                    if let Some((time, total)) =
                        timestamp(&row[0]).zip(number(&row[7]).filter(|total| *total >= 0.0))
                    {
                        output.insert(
                            time,
                            Turnover {
                                buy: 0.0,
                                sell: total,
                            },
                        );
                    }
                }
            }
            let Some(oldest) = rows
                .last()
                .and_then(|row| timestamp(&row[0]))
                .filter(|time| start < *time && *time < before)
            else {
                break;
            };
            before = oldest;
        }
        return Ok(output);
    }
    let interval = match step {
        DAY => "1d",
        HOUR => "1h",
        _ => "1m",
    };
    let limit = count.to_string();
    let start_time = start.to_string();
    let end_time = (end - 1).to_string();
    let query = [
        ("symbol", pair.id.as_str()),
        ("interval", interval),
        ("startTime", &start_time),
        ("endTime", &end_time),
        ("limit", &limit),
    ];
    let rows =
        match pair.kind {
            Kind::Futures => markets
                .binance
                .get::<Value>(
                    Endpoint::Klines,
                    json!({"symbol":pair.id,"interval":interval,"startTime":start,"endTime":end-1,
            "limit":count,"maxRetriesOnFailure":1,"maxRetriesOnFailureDelay":400}),
                )
                .await?,
            Kind::Spot => markets.http(SPOT, "klines", &query).await?,
            Kind::Alpha => markets.alpha("alpha-trade/klines", &query).await?,
        };
    let rows = rows.as_array().ok_or(MarketError::Unavailable)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let time = timestamp(&row[0])?;
            if step == DAY && timestamp(&row[6])? != time + DAY - 1 {
                return None;
            }
            let total = number(&row[7])?;
            let buy = if pair.kind == Kind::Alpha || step == DAY {
                0.0
            } else {
                number(&row[10])?
            };
            (buy >= 0.0 && buy <= total).then_some((
                time,
                Turnover {
                    buy,
                    sell: total - buy,
                },
            ))
        })
        .collect())
}

async fn volume_multiple(markets: &Markets, pair: &Instrument, now: i64) -> Option<f64> {
    let end = floor(now, DAY);
    let exchange = pair.exchange.unwrap_or(Exchange::Binance);
    let entry = markets
        .volume_multiples
        .entry((exchange, pair.id.clone()))
        .await;
    let mut cache = entry.lock().await;
    if let Some(saved) = cache.as_ref().filter(|saved| saved.until > now) {
        return saved.value;
    }
    let start = end - 181 * DAY;
    let result = async {
        let candles = candles(markets, pair, start, end, DAY).await.ok()?;
        let latest = candles.get(&(end - DAY))?.total();
        let start = start.max(ceil(pair.onboard_at, DAY));
        let count = (end - DAY - start) / DAY;
        if count < 1 {
            return None;
        }
        let total = (start..end - DAY)
            .step_by(DAY as usize)
            .try_fold(0.0, |sum, time| Some(sum + candles.get(&time)?.total()))?;
        let average = total / count as f64;
        let multiple = latest / average;
        (average > 0.0 && average.is_finite() && multiple.is_finite()).then_some(multiple)
    }
    .await;
    let until = if result.is_some() {
        end + DAY
    } else {
        (now + MINUTE).min(end + DAY)
    };
    *cache = Some(Snapshot {
        until,
        value: result,
    });
    result
}

async fn seed(markets: &Markets, pair: &Instrument, end: i64) -> Result<Seed, MarketError> {
    let start = end - MINUTE;
    let mut trades = Vec::new();
    let mut cursor: Option<i64> = None;
    if pair.exchange == Some(Exchange::Okx) {
        let mut covered = end;
        for _ in 0..8 {
            let mut params = vec![("instId", pair.id.as_str()), ("limit", "100")];
            let id = cursor.map(|id| id.to_string());
            if let Some(id) = id.as_deref() {
                params.push(("after", id));
            }
            let rows = markets.okx("market/history-trades", &params).await?;
            let mut list: Vec<_> = rows
                .iter()
                .map(|row| trade(row, pair))
                .collect::<Option<_>>()
                .ok_or(MarketError::Unavailable)?;
            let oldest = list.last().map(|row| (row.time, row.id));
            list.retain(|row| (start..end).contains(&row.time));
            trades.append(&mut list);
            if rows.len() < 100 || oldest.is_some_and(|(time, _)| time < start) {
                covered = start;
                break;
            }
            let Some((time, id)) =
                oldest.filter(|(_, id)| cursor.is_none_or(|previous| *id < previous))
            else {
                break;
            };
            covered = covered.min(time + 1);
            cursor = Some(id);
        }
        return Ok(Seed {
            trades,
            covered_from: Some(covered),
        });
    }
    for _ in 0..12 {
        let id = cursor.map(|id| id.to_string());
        let start_time = start.to_string();
        let end_time = (end - 1).to_string();
        let mut params = vec![("symbol", pair.id.as_str()), ("limit", "1000")];
        if let Some(id) = id.as_deref() {
            params.push(("fromId", id));
        } else {
            params.extend([
                ("startTime", start_time.as_str()),
                ("endTime", end_time.as_str()),
            ]);
        }
        let rows = match pair.kind {
            Kind::Futures => {
                let query = if let Some(id) = cursor {
                    json!({"symbol":pair.id,"limit":1000,"fromId":id})
                } else {
                    json!({"symbol":pair.id,"limit":1000,"startTime":start,"endTime":end-1})
                };
                markets
                    .binance
                    .get::<Value>(Endpoint::AggregateTrades, query)
                    .await?
            }
            Kind::Spot => markets.http(SPOT, "aggTrades", &params).await?,
            Kind::Alpha => markets.alpha("alpha-trade/agg-trades", &params).await?,
        };
        let rows = rows.as_array().ok_or(MarketError::Unavailable)?;
        for row in rows
            .iter()
            .filter(|row| timestamp(&row["T"]).is_some_and(|time| (start..end).contains(&time)))
        {
            trades.push(trade(row, pair).ok_or(MarketError::Unavailable)?);
        }
        if rows.len() < 1_000
            || rows
                .last()
                .and_then(|row| timestamp(&row["T"]))
                .is_some_and(|time| time >= end)
        {
            return Ok(Seed {
                trades,
                covered_from: None,
            });
        }
        let last = rows
            .last()
            .and_then(|row| row["a"].as_i64())
            .filter(|id| cursor.is_none_or(|previous| *id >= previous))
            .ok_or(MarketError::Unavailable)?;
        cursor = Some(last.checked_add(1).ok_or(MarketError::Unavailable)?);
    }
    Err(MarketError::Unavailable)
}

fn trade(row: &Value, pair: &Instrument) -> Option<Trade> {
    if pair.exchange == Some(Exchange::Okx) {
        let side = match row["side"].as_str()? {
            "buy" => "buy",
            "sell" => "sell",
            _ => return None,
        };
        let amount = number(&row["px"])? * number(&row["sz"])? * pair.contract_size.unwrap_or(1.0);
        let id = timestamp(&row["tradeId"])?;
        return (id >= 0 && amount.is_finite() && amount > 0.0).then_some(Trade {
            id,
            time: timestamp(&row["ts"])?,
            amount,
            side: Some(side),
        });
    }
    let amount = number(&row["p"])? * number(&row["q"])?;
    let side = if pair.kind == Kind::Alpha {
        None
    } else {
        Some(if row["m"].as_bool()? { "sell" } else { "buy" })
    };
    (amount.is_finite() && amount >= 0.0).then_some(Trade {
        id: row["a"].as_i64()?,
        time: row["T"].as_i64()?,
        amount,
        side,
    })
}

async fn okx_contract_windows(
    markets: &Markets,
    symbol: &str,
    end: i64,
) -> HashMap<&'static str, Value> {
    let fetch = |bar, step, windows: &'static [(&'static str, i64)]| async move {
        let as_of = floor(end, step);
        let limit = windows
            .iter()
            .map(|(_, count)| count)
            .max()
            .unwrap_or(&0)
            .to_string();
        let end = (as_of - 1).to_string();
        let rows = markets
            .okx(
                "rubik/stat/taker-volume-contract",
                &[
                    ("instId", symbol),
                    ("period", bar),
                    ("unit", "2"),
                    ("end", &end),
                    ("limit", &limit),
                ],
            )
            .await
            .unwrap_or_default();
        let amounts = rows
            .iter()
            .filter_map(|row| {
                let (buy, sell) = (number(&row[2])?, number(&row[1])?);
                (buy >= 0.0 && sell >= 0.0).then_some((timestamp(&row[0])?, Turnover { buy, sell }))
            })
            .collect();
        let block = Block {
            start: 0,
            end: as_of,
            step,
            amounts,
        };
        windows
            .iter()
            .filter_map(|(period, count)| {
                let amount = sum(&[&block], as_of - count * step, 0)?;
                let mut value = window(period, Some(amount), false);
                value["asOf"] = json!(as_of);
                value["total"] = json!(amount.total());
                Some((*period, value))
            })
            .collect::<Vec<_>>()
    };
    let (minutes, hours, days) = tokio::join!(
        fetch("5m", 5 * MINUTE, &[("5m", 1)]),
        fetch("1H", HOUR, &[("1h", 1), ("24h", 24)]),
        fetch("1Dutc", DAY, &[("7d", 7)])
    );
    minutes.into_iter().chain(hours).chain(days).collect()
}

fn short_windows(seed: Option<&Seed>, end: i64, total_only: bool) -> Vec<Value> {
    SHORT_WINDOWS
        .iter()
        .map(|(period, duration)| {
            let totals = seed
                .filter(|seed| {
                    seed.covered_from
                        .is_none_or(|start| end - duration >= start)
                })
                .map(|seed| {
                    let mut totals = Turnover::default();
                    for trade in seed
                        .trades
                        .iter()
                        .filter(|trade| (end - duration..end).contains(&trade.time))
                    {
                        if trade.side == Some("sell") {
                            totals.sell += trade.amount;
                        } else {
                            totals.buy += trade.amount;
                        }
                    }
                    totals
                });
            window(period, totals, total_only)
        })
        .collect()
}

fn window(period: &str, amount: Option<Turnover>, total_only: bool) -> Value {
    if total_only {
        json!({"period":period,"amounts":null,"total":amount.map(Turnover::total)})
    } else {
        json!({"period":period,"amounts":amount.map(|row| json!({"buy":row.buy,"sell":row.sell}))})
    }
}

fn sum(blocks: &[&Block], start: i64, onboard_at: i64) -> Option<Turnover> {
    let mut total = Turnover::default();
    for block in blocks {
        for time in
            (ceil(start.max(block.start), block.step)..block.end).step_by(block.step as usize)
        {
            if time + block.step <= onboard_at {
                continue;
            }
            let amount = block.amounts.get(&time)?;
            total.buy += amount.buy;
            total.sell += amount.sell;
        }
    }
    Some(total)
}

fn timestamp(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn floor(time: i64, step: i64) -> i64 {
    time.div_euclid(step) * step
}
fn ceil(time: i64, step: i64) -> i64 {
    floor(time + step - 1, step)
}
