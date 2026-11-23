use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::binance::{number, Binance, Endpoint, UpstreamError};
use crate::now_ms;

const OKX: &str = "https://www.okx.com/api/v5";
pub const SPOT: &str = "https://data-api.binance.vision/api/v3";
const ALPHA: &str = "https://www.binance.com/bapi/defi/v1/public";
const LISTING_AGE: i64 = 15_000;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Exchange {
    Binance,
    Okx,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Futures,
    Spot,
    Alpha,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub id: String,
    pub base: String,
    pub quote: String,
    pub coin: String,
    #[serde(rename = "type")]
    pub contract_type: String,
    pub onboard_at: i64,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange: Option<Exchange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
}

impl Instrument {
    fn new(
        id: &str,
        base: &str,
        coin: &str,
        kind: Kind,
        contract_type: &str,
        onboard_at: i64,
    ) -> Self {
        Self {
            id: id.into(),
            base: base.into(),
            quote: "USDT".into(),
            coin: coin.into(),
            contract_type: contract_type.into(),
            onboard_at,
            kind,
            exchange: None,
            contract_size: None,
            name: None,
            chain: None,
            address: None,
        }
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    instruments: Vec<Instrument>,
    updated_at: Option<i64>,
    stale: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum MarketError {
    Missing,
    RateLimit,
    Unavailable,
}

impl From<UpstreamError> for MarketError {
    fn from(error: UpstreamError) -> Self {
        match error {
            UpstreamError::RateLimit => Self::RateLimit,
            UpstreamError::Missing => Self::Missing,
            UpstreamError::Unavailable => Self::Unavailable,
        }
    }
}

pub struct Snapshot<T> {
    pub value: T,
    pub until: i64,
}
type Entry<T> = Arc<Mutex<Option<Snapshot<T>>>>;

pub struct Cache<K, T>(Mutex<HashMap<K, Entry<T>>>);

impl<K: Eq + Hash, T> Cache<K, T> {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    pub async fn entry(&self, key: K) -> Entry<T> {
        Arc::clone(self.0.lock().await.entry(key).or_default())
    }
}

pub struct Markets {
    pub binance: Arc<Binance>,
    client: Client,
    listings: Cache<(Exchange, Kind), Listing>,
    coins: Cache<String, String>,
    funding: Cache<(Exchange, String), Value>,
    books: Cache<(Exchange, String), Value>,
    pub volume_multiples: Cache<(Exchange, String), Option<f64>>,
}

impl Markets {
    pub fn new(binance: Arc<Binance>) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            binance,
            client,
            listings: Cache::new(),
            coins: Cache::new(),
            funding: Cache::new(),
            books: Cache::new(),
            volume_multiples: Cache::new(),
        })
    }

    pub async fn http(
        &self,
        base: &str,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Value, MarketError> {
        let response = self
            .client
            .get(format!("{base}/{path}"))
            .query(query)
            .send()
            .await
            .map_err(|_| MarketError::Unavailable)?;
        if matches!(response.status().as_u16(), 418 | 429) {
            return Err(MarketError::RateLimit);
        }
        if !response.status().is_success() {
            return Err(MarketError::Unavailable);
        }
        response.json().await.map_err(|_| MarketError::Unavailable)
    }

    pub async fn alpha(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, MarketError> {
        let response = self.http(ALPHA, path, query).await?;
        if response["code"] != "000000"
            || response["success"] == false
            || response["data"].is_null()
        {
            return Err(MarketError::Unavailable);
        }
        Ok(response["data"].clone())
    }

    pub async fn okx(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<Value>, MarketError> {
        let response = self.http(OKX, path, query).await?;
        if response["code"] == "50011" {
            return Err(MarketError::RateLimit);
        }
        if response["code"] != "0" {
            return Err(MarketError::Unavailable);
        }
        response["data"]
            .as_array()
            .cloned()
            .ok_or(MarketError::Unavailable)
    }

    pub async fn directory(&self, exchange: Exchange) -> Value {
        let listing = |kind| async move {
            self.listing(exchange, kind, 3_000)
                .await
                .unwrap_or_else(|_| Listing {
                    stale: true,
                    ..Listing::default()
                })
        };
        let (futures, spot, alpha) = tokio::join!(
            listing(Kind::Futures),
            listing(Kind::Spot),
            listing(Kind::Alpha)
        );
        json!({"futures": futures, "spot": spot, "alpha": alpha})
    }

    async fn listing(
        &self,
        exchange: Exchange,
        kind: Kind,
        age: i64,
    ) -> Result<Listing, MarketError> {
        let entry = self.listings.entry((exchange, kind)).await;
        let mut cache = entry.lock().await;
        if let Some(snapshot) = cache
            .as_ref()
            .filter(|snapshot| snapshot.until + age > now_ms())
        {
            return Ok(snapshot.value.clone());
        }
        match self.load(exchange, kind).await {
            Ok(instruments) => {
                let now = now_ms();
                let listing = Listing {
                    instruments,
                    updated_at: Some(now),
                    stale: false,
                };
                *cache = Some(Snapshot {
                    until: now,
                    value: listing.clone(),
                });
                Ok(listing)
            }
            Err(error) => cache
                .as_ref()
                .map(|entry| Listing {
                    stale: true,
                    ..entry.value.clone()
                })
                .ok_or(error),
        }
    }

    pub async fn instrument(
        &self,
        exchange: Exchange,
        kind: Kind,
        symbol: &str,
    ) -> Result<Instrument, MarketError> {
        self.listing(exchange, kind, LISTING_AGE)
            .await?
            .instruments
            .into_iter()
            .find(|pair| pair.id == symbol)
            .ok_or(MarketError::Missing)
    }

    pub async fn binance_contracts(&self) -> Result<Vec<Instrument>, MarketError> {
        Ok(self
            .listing(Exchange::Binance, Kind::Futures, LISTING_AGE)
            .await?
            .instruments)
    }

    async fn load(&self, exchange: Exchange, kind: Kind) -> Result<Vec<Instrument>, MarketError> {
        if exchange == Exchange::Okx {
            if kind == Kind::Alpha {
                return Ok(Vec::new());
            }
            let rows = self
                .okx(
                    "public/instruments",
                    &[("instType", if kind == Kind::Spot { "SPOT" } else { "SWAP" })],
                )
                .await?;
            return Ok(rows.iter().filter_map(|row| okx_pair(row, kind)).collect());
        }
        match kind {
            Kind::Futures => {
                let directory = self.binance.directory(3_000).await?;
                let mut pairs = Vec::with_capacity(directory.contracts.len());
                for contract in directory.contracts {
                    let base = contract.base.to_uppercase();
                    let coin = if contract.kind == "PERPETUAL" {
                        self.binance_coin(&contract.id, &base).await
                    } else {
                        base
                    };
                    pairs.push(Instrument::new(
                        &contract.id,
                        &contract.base,
                        &coin,
                        kind,
                        &contract.kind,
                        contract.onboard_at,
                    ));
                }
                Ok(pairs)
            }
            Kind::Spot => {
                let rows = self
                    .http(
                        SPOT,
                        "exchangeInfo",
                        &[("symbolStatus", "TRADING"), ("showPermissionSets", "false")],
                    )
                    .await?;
                let rows = rows["symbols"].as_array().ok_or(MarketError::Unavailable)?;
                Ok(rows
                    .iter()
                    .filter(|row| row["isSpotTradingAllowed"] == true)
                    .filter_map(|row| {
                        listed_pair(row).map(|(id, base)| {
                            Instrument::new(id, base, &base.to_uppercase(), kind, "SPOT", 0)
                        })
                    })
                    .collect())
            }
            Kind::Alpha => {
                let (pairs, tokens) = tokio::join!(
                    self.alpha("alpha-trade/get-exchange-info", &[]),
                    self.alpha("wallet-direct/buw/wallet/cex/alpha/all/token/list", &[])
                );
                let (pairs, tokens) = (pairs?, tokens?);
                let tokens: HashMap<_, _> = tokens
                    .as_array()
                    .ok_or(MarketError::Unavailable)?
                    .iter()
                    .filter_map(|token| Some((token["alphaId"].as_str()?, token)))
                    .collect();
                Ok(pairs["symbols"]
                    .as_array()
                    .ok_or(MarketError::Unavailable)?
                    .iter()
                    .filter_map(|row| {
                        listed_pair(row)
                            .map(|(id, base)| alpha_pair(id, base, tokens.get(base).copied()))
                    })
                    .collect())
            }
        }
    }

    async fn binance_coin(&self, symbol: &str, base: &str) -> String {
        if let Some(coin) = bundled_coin(base) {
            return coin.to_owned();
        }
        let Some(underlying) = bundle_candidate(base) else {
            return base.to_owned();
        };
        let entry = self.coins.entry(symbol.to_owned()).await;
        let mut cache = entry.lock().await;
        if let Some(snapshot) = cache.as_ref().filter(|snapshot| snapshot.until > now_ms()) {
            return snapshot.value.clone();
        }
        let response: Result<Value, _> = self
            .binance
            .get(Endpoint::Constituents, json!({"symbol": symbol}))
            .await;
        let expected = format!("{underlying}USDT");
        let coin = if response.as_ref().is_ok_and(|index| {
            index["symbol"] == symbol
                && index["constituents"].as_array().is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row["exchange"]
                            .as_str()
                            .is_some_and(|value| value.eq_ignore_ascii_case("binance"))
                            && row["symbol"]
                                .as_str()
                                .is_some_and(|value| value.eq_ignore_ascii_case(&expected))
                    })
                })
        }) {
            underlying
        } else {
            base
        }
        .to_owned();
        let duration = if response.is_ok() {
            1_800_000
        } else {
            LISTING_AGE
        };
        *cache = Some(Snapshot {
            value: coin.clone(),
            until: now_ms() + duration,
        });
        coin
    }

    pub async fn ticker(
        &self,
        exchange: Exchange,
        kind: Kind,
        symbol: &str,
    ) -> Result<Value, MarketError> {
        self.instrument(exchange, kind, symbol).await?;
        if exchange == Exchange::Okx {
            let fetched_at = now_ms();
            let response = self.okx("market/ticker", &[("instId", symbol)]).await?;
            let row = response.first().ok_or(MarketError::Unavailable)?;
            let last = number(&row["last"]);
            let change = last
                .zip(number(&row["open24h"]).filter(|open| *open > 0.0))
                .map(|(last, open)| (last / open - 1.0) * 100.0);
            return Ok(
                json!({"symbol": symbol,"last":last,"bid":number(&row["bidPx"]),"ask":number(&row["askPx"]),
                "changePercent":change,"baseVolume":number(&row[if kind == Kind::Spot {"vol24h"} else {"volCcy24h"}]),"timestamp":number(&row["ts"]),"fetchedAt":fetched_at}),
            );
        }
        let futures_params = json!({"symbol": symbol});
        let params = [("symbol", symbol)];
        let (last, best): (Result<Value, MarketError>, Result<Value, MarketError>) = match kind {
            Kind::Futures => {
                let (last, best) = tokio::join!(
                    self.binance.get(Endpoint::Ticker, futures_params.clone()),
                    self.binance.get(Endpoint::BookTicker, futures_params)
                );
                (last.map_err(Into::into), best.map_err(Into::into))
            }
            Kind::Spot => tokio::join!(
                self.http(SPOT, "ticker/24hr", &params),
                self.http(SPOT, "ticker/bookTicker", &params)
            ),
            Kind::Alpha => {
                let depth_params = [("symbol", symbol), ("limit", "5")];
                let (last, best) = tokio::join!(
                    self.alpha("alpha-trade/ticker", &params),
                    self.alpha("alpha-trade/fullDepth", &depth_params)
                );
                (last, best.map(|book| json!({"symbol":book["symbol"],"bidPrice":book["bids"][0][0],"askPrice":book["asks"][0][0]})))
            }
        };
        let last = last?;
        if last["symbol"] != symbol {
            return Err(MarketError::Unavailable);
        }
        let book = best
            .ok()
            .filter(|row| row["symbol"] == symbol)
            .unwrap_or_default();
        Ok(
            json!({"symbol":symbol,"last":number(&last["lastPrice"]),"bid":number(&book["bidPrice"]),"ask":number(&book["askPrice"]),
            "changePercent":number(&last["priceChangePercent"]),"baseVolume":number(&last["volume"]),"timestamp":number(&last["closeTime"]),"fetchedAt":now_ms()}),
        )
    }

    pub async fn book(&self, exchange: Exchange, symbol: &str) -> Result<Value, MarketError> {
        let pair = self.instrument(exchange, Kind::Futures, symbol).await?;
        let entry = self.books.entry((exchange, symbol.to_owned())).await;
        let mut cache = entry.lock().await;
        if let Some(snapshot) = cache.as_ref().filter(|snapshot| snapshot.until > now_ms()) {
            return Ok(snapshot.value.clone());
        }
        let (book, time) = if exchange == Exchange::Okx {
            let mut rows = self
                .okx("market/books-full", &[("instId", symbol), ("sz", "5000")])
                .await?;
            let book = rows.pop().ok_or(MarketError::Unavailable)?;
            let time = number(&book["ts"]);
            (book, time)
        } else {
            let book: Value = self
                .binance
                .get(Endpoint::Depth, json!({"symbol":symbol,"limit":1000}))
                .await?;
            let time = number(if book["E"].is_null() {
                &book["T"]
            } else {
                &book["E"]
            });
            (book, time)
        };
        let multiplier = pair.contract_size.unwrap_or(1.0);
        let bids = normalize_levels(&book["bids"], multiplier, true);
        let asks = normalize_levels(&book["asks"], multiplier, false);
        let now = now_ms();
        let time = time
            .filter(|time| {
                time.fract() == 0.0 && ((now - 15_000) as f64..=(now + 2_000) as f64).contains(time)
            })
            .ok_or(MarketError::Unavailable)?;
        if !bids
            .first()
            .zip(asks.first())
            .is_some_and(|(bid, ask)| bid[0] < ask[0])
        {
            return Err(MarketError::Unavailable);
        }
        let value = json!({"exchange":exchange,"symbol":symbol,"base":pair.base,"time":time,"bids":bids,"asks":asks});
        *cache = Some(Snapshot {
            until: now + 5_000,
            value: value.clone(),
        });
        Ok(value)
    }

    pub async fn funding(&self, exchange: Exchange, symbol: &str) -> Result<Value, MarketError> {
        let pair = self.instrument(exchange, Kind::Futures, symbol).await?;
        let entry = self.funding.entry((exchange, symbol.to_owned())).await;
        let mut cache = entry.lock().await;
        if let Some(snapshot) = cache.as_ref().filter(|snapshot| snapshot.until > now_ms()) {
            return Ok(snapshot.value.clone());
        }
        let (history, next) = if exchange == Exchange::Okx {
            let history_params = [("instId", symbol), ("limit", "12")];
            let quote_params = [("instId", symbol)];
            let (history, quote) = tokio::join!(
                self.okx("public/funding-rate-history", &history_params),
                self.okx("public/funding-rate", &quote_params)
            );
            let rows = history
                .unwrap_or_default()
                .into_iter()
                .filter(|row| row["instId"] == symbol)
                .filter_map(|row| funding_point(&row["realizedRate"], &row["fundingTime"]))
                .collect::<Vec<_>>();
            let quote = quote
                .ok()
                .and_then(|rows| rows.into_iter().next())
                .filter(|row| row["instId"] == symbol);
            (
                rows,
                quote.and_then(|row| funding_point(&row["fundingRate"], &row["fundingTime"])),
            )
        } else {
            let limit = if pair.contract_type == "TRADIFI_PERPETUAL" {
                24
            } else {
                12
            };
            let (history, quote): (Result<Vec<Value>, _>, Result<Value, _>) = tokio::join!(
                self.binance.get(
                    Endpoint::FundingHistory,
                    json!({"symbol":symbol,"limit":limit})
                ),
                self.binance
                    .get(Endpoint::PremiumIndex, json!({"symbol":symbol}))
            );
            let rows = history
                .unwrap_or_default()
                .into_iter()
                .filter(|row| row["symbol"] == symbol && row["rateType"] != "Special")
                .filter_map(|row| funding_point(&row["fundingRate"], &row["fundingTime"]))
                .collect();
            let quote = quote.ok().filter(|row| row["symbol"] == symbol);
            (
                rows,
                quote.and_then(|row| {
                    funding_point(&row["lastFundingRate"], &row["nextFundingTime"])
                }),
            )
        };
        let now = now_ms();
        let settled: BTreeMap<_, _> = history
            .into_iter()
            .filter(|point| point.time <= now)
            .map(|point| (point.time, point))
            .collect();
        let history: Vec<_> = settled.into_values().rev().take(12).collect();
        let next = next.filter(|point| point.time > now);
        if history.is_empty() && next.is_none() {
            return Err(MarketError::Unavailable);
        }
        let previous = history.first();
        let value = json!({"exchange":exchange,"symbol":symbol,"updatedAt":now,"history":history,"previous":previous,"next":next});
        *cache = Some(Snapshot {
            until: (now + 30_000).min(next.map_or(i64::MAX, |point| point.time)),
            value: value.clone(),
        });
        Ok(value)
    }
}

fn listed_pair(row: &Value) -> Option<(&str, &str)> {
    if row["status"] != "TRADING" || row["quoteAsset"] != "USDT" {
        return None;
    }
    Some((row["symbol"].as_str()?, row["baseAsset"].as_str()?))
}

fn alpha_pair(id: &str, base: &str, token: Option<&Value>) -> Instrument {
    let token = token.unwrap_or(&Value::Null);
    let display = token["symbol"]
        .as_str()
        .map(str::trim)
        .filter(|symbol| !symbol.is_empty())
        .unwrap_or(base);
    let ticker = display.to_uppercase();
    let addr = token["contractAddress"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    let coin = match addr.as_str() {
        "0x6894cde390a3f51155ea41ed24a33a4827d3063d" => "1000CAT",
        "0x0df0587216a4a1bb7d5082fdc491d93d2dd4b413" => "1000CHEEMS",
        _ if ticker == "PEPE" && addr != "0x6982508145454ce325ddbe47a25d4ec3d2311933" => base,
        _ => &ticker,
    };
    let mut pair = Instrument::new(id, display, coin, Kind::Alpha, "ALPHA", 0);
    pair.name = token["name"].as_str().map(str::to_owned);
    pair.chain = token["chainName"].as_str().map(str::to_owned);
    pair.address = token["contractAddress"].as_str().map(str::to_owned);
    pair
}

fn okx_pair(row: &Value, kind: Kind) -> Option<Instrument> {
    if row["state"] != "live" {
        return None;
    }
    let id = row["instId"].as_str()?;
    let (base, quote, size, contract_type) = if kind == Kind::Spot {
        (
            row["baseCcy"].as_str()?,
            row["quoteCcy"].as_str()?,
            1.0,
            "SPOT",
        )
    } else {
        let (base, quote) = row["uly"].as_str()?.split_once('-')?;
        if row["settleCcy"] != quote || row["ctType"] != "linear" || row["ctValCcy"] != base {
            return None;
        }
        (
            base,
            quote,
            number(&row["ctVal"]).filter(|size| *size > 0.0)?,
            "PERPETUAL",
        )
    };
    if base.is_empty() || quote != "USDT" {
        return None;
    }
    let coin = match id {
        "CAT-USDT" => "1000CAT",
        "SATS-USDT" | "SATS-USDT-SWAP" => "1000SATS",
        "BABYDOGE-USDT" => "1MBABYDOGE",
        _ => base,
    };
    let mut pair = Instrument::new(
        id,
        base,
        coin,
        kind,
        contract_type,
        number(&row["listTime"]).unwrap_or_default() as i64,
    );
    pair.exchange = Some(Exchange::Okx);
    pair.contract_size = Some(size);
    Some(pair)
}

pub fn bundled_coin(base: &str) -> Option<&str> {
    Some(match base {
        "1000SHIB" => "SHIB",
        "1000XEC" => "XEC",
        "1000LUNC" => "LUNC",
        "1000PEPE" => "PEPE",
        "1000FLOKI" => "FLOKI",
        "1000BONK" => "BONK",
        "1000000MOG" => "MOG",
        "1000CAT" | "1000CHEEMS" | "1000SATS" | "1000RATS" | "1MBABYDOGE" => base,
        _ => return None,
    })
}

pub fn bundle_candidate(base: &str) -> Option<&str> {
    let digits = base.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || base.starts_with('0') {
        return None;
    }
    let (prefix, suffix) = base.split_at(digits);
    let zeros = prefix.starts_with('1')
        && prefix.len() >= 4
        && prefix[1..].bytes().all(|byte| byte == b'0');
    let suffix = if zeros
        && suffix
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_uppercase)
    {
        suffix
    } else {
        suffix.strip_prefix(['K', 'M'])?
    };
    (suffix
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_uppercase)
        && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    .then_some(suffix)
}

fn normalize_levels(rows: &Value, multiplier: f64, descending: bool) -> Vec<[f64; 2]> {
    let mut levels = Vec::new();
    for row in rows.as_array().into_iter().flatten() {
        if let Some((price, quantity)) = number(&row[0])
            .zip(number(&row[1]).map(|quantity| quantity * multiplier))
            .filter(|(price, quantity)| {
                *price > 0.0 && *quantity > 0.0 && (price * quantity).is_finite()
            })
        {
            levels.push([price, quantity]);
        }
    }
    levels.reverse();
    levels.sort_by(|left, right| {
        if descending {
            right[0].total_cmp(&left[0])
        } else {
            left[0].total_cmp(&right[0])
        }
    });
    levels.dedup_by(|left, right| left[0] == right[0]);
    levels
}

#[derive(Clone, Copy, Serialize)]
struct FundingPoint {
    time: i64,
    rate: f64,
}

fn funding_point(rate: &Value, time: &Value) -> Option<FundingPoint> {
    let time = number(time)
        .filter(|time| *time > 0.0 && *time <= 9_007_199_254_740_991.0 && time.fract() == 0.0)?
        as i64;
    Some(FundingPoint {
        time,
        rate: number(rate)?,
    })
}
