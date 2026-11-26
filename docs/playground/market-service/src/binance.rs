use std::collections::HashMap;
use std::env;

use ccxt_pro::exchanges::binanceusdm::BinanceusdmCore;
use ccxt_pro::{runtime::call_typed, Config, Value as ExchangeValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::now_ms;
use crate::strategy::{turnover_baseline, Sample, Volume};

const MINUTE: i64 = 60_000;
const TRADE_PAGE_SIZE: usize = 1_000;
const MAX_TRADE_PAGES: usize = 12;
pub const VOLUME_DELAY_MS: i64 = 2_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub id: String,
    pub base: String,
    pub quote: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub onboard_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub contracts: Vec<Contract>,
    pub updated_at: i64,
}

#[derive(Deserialize)]
struct ExchangeInfo {
    symbols: Vec<ExchangeSymbol>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeSymbol {
    symbol: String,
    base_asset: String,
    quote_asset: String,
    margin_asset: String,
    contract_type: String,
    underlying_type: Option<String>,
    status: String,
    onboard_date: i64,
}

impl ExchangeSymbol {
    fn is_crypto_perpetual(&self) -> bool {
        self.status == "TRADING"
            && self.quote_asset == "USDT"
            && self.margin_asset == "USDT"
            && self.contract_type == "PERPETUAL"
            && matches!(self.underlying_type.as_deref(), Some("COIN" | "PREMARKET"))
    }
}

#[derive(Clone, Copy)]
pub enum Endpoint {
    ExchangeInfo,
    Klines,
    AggregateTrades,
    AccountRatio,
    PositionRatio,
    Constituents,
    Ticker,
    BookTicker,
    Depth,
    FundingHistory,
    PremiumIndex,
    MarkKlines,
    OpenInterestHistory,
}

#[derive(Debug)]
pub enum UpstreamError {
    RateLimit,
    Missing,
    Unavailable,
}

pub struct Binance {
    rest: Mutex<BinanceusdmCore>,
    directory: Mutex<Option<Directory>>,
}

impl Binance {
    pub fn new() -> Self {
        Self {
            rest: Mutex::new(BinanceusdmCore::new(exchange_config().into_option())),
            directory: Mutex::new(None),
        }
    }

    pub async fn get<T: serde::de::DeserializeOwned>(
        &self,
        endpoint: Endpoint,
        query: Value,
    ) -> Result<T, UpstreamError> {
        let mut rest = self.rest.lock().await;
        let args = [ExchangeValue::from_json(&query)];
        let response = call_typed(async {
            match endpoint {
                Endpoint::ExchangeInfo => rest.fapi_public_get_exchange_info(&args).await,
                Endpoint::Klines => rest.fapi_public_get_klines(&args).await,
                Endpoint::AggregateTrades => rest.fapi_public_get_agg_trades(&args).await,
                Endpoint::AccountRatio => {
                    rest.fapi_data_get_global_long_short_account_ratio(&args)
                        .await
                }
                Endpoint::PositionRatio => {
                    rest.fapi_data_get_top_long_short_position_ratio(&args)
                        .await
                }
                Endpoint::Constituents => rest.fapi_public_get_constituents(&args).await,
                Endpoint::Ticker => rest.fapi_public_get_ticker24hr(&args).await,
                Endpoint::BookTicker => rest.fapi_public_get_ticker_book_ticker(&args).await,
                Endpoint::Depth => rest.fapi_public_get_depth(&args).await,
                Endpoint::FundingHistory => rest.fapi_public_get_funding_rate(&args).await,
                Endpoint::PremiumIndex => rest.fapi_public_get_premium_index(&args).await,
                Endpoint::MarkKlines => rest.fapi_public_get_mark_price_klines(&args).await,
                Endpoint::OpenInterestHistory => rest.fapi_data_get_open_interest_hist(&args).await,
            }
        })
        .await
        .map_err(|error| {
            if error.is("RateLimitExceeded") {
                UpstreamError::RateLimit
            } else if error.is("BadSymbol") {
                UpstreamError::Missing
            } else {
                UpstreamError::Unavailable
            }
        })?;
        serde_json::from_value(response.to_json()).map_err(|_| UpstreamError::Unavailable)
    }

    pub async fn directory(&self, max_age_ms: i64) -> Result<Directory, UpstreamError> {
        let mut cache = self.directory.lock().await;
        if let Some(current) = cache
            .as_ref()
            .filter(|entry| now_ms() - entry.updated_at < max_age_ms)
        {
            return Ok(current.clone());
        }
        let info: ExchangeInfo = self.get(Endpoint::ExchangeInfo, json!({})).await?;
        let mut contracts: Vec<_> = info
            .symbols
            .into_iter()
            .filter(ExchangeSymbol::is_crypto_perpetual)
            .map(|market| Contract {
                id: market.symbol,
                base: market.base_asset,
                quote: market.quote_asset,
                kind: market.contract_type,
                onboard_at: market.onboard_date,
            })
            .collect();
        contracts.sort_by(|left, right| left.id.cmp(&right.id));
        let directory = Directory {
            contracts,
            updated_at: now_ms(),
        };
        *cache = Some(directory.clone());
        Ok(directory)
    }

    pub async fn contract(&self, symbol: &str) -> Result<Option<Contract>, UpstreamError> {
        Ok(self
            .directory(15_000)
            .await?
            .contracts
            .into_iter()
            .find(|contract| contract.id == symbol))
    }

    pub async fn day_open(
        &self,
        symbol: &str,
        start: i64,
        end: i64,
    ) -> Result<Option<f64>, UpstreamError> {
        let rows: Vec<Vec<Value>> = self.get(Endpoint::Klines, json!({
            "symbol": symbol, "interval": "1h", "startTime": start, "endTime": end, "limit": 24,
        })).await?;
        Ok(rows
            .iter()
            .find(|row| {
                row.first()
                    .and_then(Value::as_i64)
                    .is_some_and(|time| (start..=end).contains(&time))
            })
            .and_then(|row| number(row.get(1)?))
            .filter(|open| *open > 0.0))
    }

    pub async fn turnover(&self, contract: &Contract, start: i64, end: i64) -> Option<f64> {
        let start = start.max(contract.onboard_at);
        if start >= end {
            return Some(0.0);
        }
        let first_minute = (start + MINUTE - 1).div_euclid(MINUTE) * MINUTE;
        let last_minute = end.div_euclid(MINUTE) * MINUTE;
        if first_minute > last_minute {
            return self
                .trade_window(&contract.id, start, end)
                .await
                .ok()
                .map(|trades| trades.total);
        }
        let (middle, head, tail) = tokio::join!(
            self.minute_turnover(&contract.id, first_minute, last_minute),
            self.trade_window(&contract.id, start, first_minute),
            self.trade_window(&contract.id, last_minute, end),
        );
        let middle = middle.ok()?;
        let total = (first_minute..last_minute)
            .step_by(MINUTE as usize)
            .try_fold(0.0, |sum, time| Some(sum + middle.get(&time)?))?
            + head.ok()?.total
            + tail.ok()?.total;
        total.is_finite().then_some(total)
    }

    pub async fn compare_turnover(&self, contract: &Contract, end: i64, seconds: u32) -> Volume {
        let start = end - i64::from(seconds) * 1_000;
        let baseline_end = start.div_euclid(MINUTE) * MINUTE;
        let baseline_start = baseline_end - 60 * MINUTE;
        let baseline = async {
            if baseline_start < contract.onboard_at {
                return None;
            }
            let rows = self
                .minute_turnover(&contract.id, baseline_start, baseline_end)
                .await
                .ok()?;
            let minutes: Vec<_> = (baseline_start..baseline_end)
                .step_by(MINUTE as usize)
                .map(|time| rows.get(&time).copied())
                .collect();
            turnover_baseline(&minutes, seconds)
        };
        let (turnover, baseline) = tokio::join!(self.turnover(contract, start, end), baseline);
        Volume::new(turnover, baseline)
    }

    async fn minute_turnover(
        &self,
        symbol: &str,
        start: i64,
        end: i64,
    ) -> Result<HashMap<i64, f64>, UpstreamError> {
        if start >= end {
            return Ok(HashMap::new());
        }
        let rows: Vec<Vec<Value>> = self.get(Endpoint::Klines, json!({
            "symbol": symbol, "interval": "1m", "startTime": start, "endTime": end - 1,
            "limit": (end - start) / MINUTE, "maxRetriesOnFailure": 1, "maxRetriesOnFailureDelay": 400,
        })).await?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let time = row.first()?.as_i64()?;
                let total = number(row.get(7)?)?;
                let buy = number(row.get(10)?)?;
                (buy >= 0.0 && buy <= total).then_some((time, total))
            })
            .collect())
    }

    pub(crate) async fn trade_window(
        &self,
        symbol: &str,
        start: i64,
        end: i64,
    ) -> Result<TradeWindow, UpstreamError> {
        let mut trades = TradeWindow::default();
        if start >= end {
            return Ok(trades);
        }
        let mut from_id = None;
        for _ in 0..MAX_TRADE_PAGES {
            let query = match from_id {
                None => {
                    json!({"symbol": symbol, "startTime": start, "endTime": end - 1, "limit": TRADE_PAGE_SIZE})
                }
                Some(id) => json!({"symbol": symbol, "fromId": id, "limit": TRADE_PAGE_SIZE}),
            };
            let page: Vec<AggregateTrade> = self.get(Endpoint::AggregateTrades, query).await?;
            for trade in page
                .iter()
                .filter(|trade| (start..end).contains(&trade.time))
            {
                trades.add(trade)?;
            }
            if page.len() < TRADE_PAGE_SIZE || page.last().is_some_and(|last| last.time >= end) {
                return trades
                    .total
                    .is_finite()
                    .then_some(trades)
                    .ok_or(UpstreamError::Unavailable);
            }
            let last = page.last().ok_or(UpstreamError::Unavailable)?;
            if from_id.is_some_and(|previous| last.id < previous) {
                return Err(UpstreamError::Unavailable);
            }
            from_id = Some(last.id.checked_add(1).ok_or(UpstreamError::Unavailable)?);
        }
        Err(UpstreamError::Unavailable)
    }

    pub async fn ratios(&self, symbol: &str, time: i64) -> AlertContext {
        let query = json!({"symbol": symbol, "period": "5m", "limit": 2, "endTime": time});
        let (accounts, positions): (Result<Vec<Value>, _>, Result<Vec<Value>, _>) = tokio::join!(
            self.get(Endpoint::AccountRatio, query.clone()),
            self.get(Endpoint::PositionRatio, query),
        );
        AlertContext {
            turnover: None,
            binance_accounts: accounts
                .ok()
                .and_then(|rows| read_ratio(&rows, time, "longAccount", "shortAccount")),
            binance_positions: positions
                .ok()
                .and_then(|rows| read_ratio(&rows, time, "longPosition", "shortPosition")),
        }
    }
}

fn exchange_config() -> Config {
    let mut config = Config::new().timeout_ms(8_000).enable_rate_limit(true);
    if let Some(proxy) = outbound_proxy() {
        config = config.set_str("httpsProxy", &proxy);
    }
    config
}

pub fn outbound_proxy() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .filter_map(|key| env::var(key).ok())
        .find(|value| !value.is_empty())
}

#[derive(Deserialize)]
struct AggregateTrade {
    #[serde(rename = "a")]
    id: i64,
    #[serde(rename = "T")]
    time: i64,
    #[serde(rename = "p")]
    price: Value,
    #[serde(rename = "q")]
    quantity: Value,
    #[serde(rename = "m")]
    buyer_is_maker: bool,
}

#[derive(Default)]
pub(crate) struct TradeWindow {
    pub total: f64,
    pub taker_buy: f64,
    pub low: f64,
    pub high: f64,
    pub last: Option<Sample>,
}

impl TradeWindow {
    fn add(&mut self, trade: &AggregateTrade) -> Result<(), UpstreamError> {
        let price = number(&trade.price).ok_or(UpstreamError::Unavailable)?;
        let quantity = number(&trade.quantity).ok_or(UpstreamError::Unavailable)?;
        let amount = price * quantity;
        if !amount.is_finite() || price <= 0.0 || quantity < 0.0 {
            return Err(UpstreamError::Unavailable);
        }
        self.total += amount;
        if !trade.buyer_is_maker {
            self.taker_buy += amount;
        }
        if amount > 0.0 {
            self.low = self.last.map_or(price, |_| self.low.min(price));
            self.high = self.high.max(price);
            if self.last.is_none_or(|last| trade.time >= last.time) {
                self.last = Some(Sample { time: trade.time, price });
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct Ratio {
    ratio: f64,
    long: f64,
    short: f64,
    time: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertContext {
    pub turnover: Option<f64>,
    binance_accounts: Option<Ratio>,
    binance_positions: Option<Ratio>,
}

fn read_ratio(rows: &[Value], end: i64, long_key: &str, short_key: &str) -> Option<Ratio> {
    let row = rows
        .iter()
        .rev()
        .find(|row| row["timestamp"].as_i64().is_some_and(|time| time <= end))?;
    let share = |key: &str, fallback: &str| {
        number(if row[key].is_null() {
            &row[fallback]
        } else {
            &row[key]
        })
        .filter(|n| *n >= 0.0)
    };
    Some(Ratio {
        ratio: share("longShortRatio", "longShortRatio")?,
        long: share(long_key, "longAccount")?,
        short: share(short_key, "shortAccount")?,
        time: row["timestamp"].as_i64()?,
    })
}

pub fn number(value: &Value) -> Option<f64> {
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())?;
    number.is_finite().then_some(number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trade_window_uses_the_taker_side_and_keeps_the_price_extremes() {
        let mut trades = TradeWindow::default();
        for trade in [
            json!({"a":1,"T":1000,"p":"105.00","q":"2","m":false}),
            json!({"a":2,"T":2000,"p":"104.00","q":"1","m":true}),
            json!({"a":3,"T":2000,"p":"106.00","q":"1","m":false}),
        ] {
            trades.add(&serde_json::from_value(trade).unwrap()).unwrap();
        }
        assert_eq!(trades.total, 420.0);
        assert_eq!(trades.taker_buy, 316.0);
        assert_eq!(trades.low, 104.0);
        assert_eq!(trades.high, 106.0);
        assert_eq!(trades.last, Some(Sample { time: 2000, price: 106.0 }));
    }

    #[test]
    fn directory_keeps_only_trading_usdt_crypto_perpetuals() {
        for (symbol, contract_type, underlying_type, expected) in [
            ("BTCUSDT", "PERPETUAL", Some("COIN"), true),
            ("PREDICTUSDT", "PERPETUAL", Some("PREMARKET"), true),
            ("HANMIUSDT", "TRADIFI_PERPETUAL", Some("KR_EQUITY"), false),
            ("NATGASUSDT", "TRADIFI_PERPETUAL", Some("COMMODITY"), false),
            ("OPENAIUSDT", "TRADIFI_PERPETUAL", Some("PREMARKET"), false),
            ("BTCDOMUSDT", "PERPETUAL", Some("INDEX"), false),
            ("UNKNOWNUSDT", "PERPETUAL", None, false),
        ] {
            let market: ExchangeSymbol = serde_json::from_value(json!({
                "symbol": symbol, "baseAsset": "TEST", "quoteAsset": "USDT",
                "marginAsset": "USDT", "contractType": contract_type, "status": "TRADING",
                "underlyingType": underlying_type, "onboardDate": 1,
            }))
            .unwrap();
            assert_eq!(market.is_crypto_perpetual(), expected, "{symbol}");
        }
    }
}
