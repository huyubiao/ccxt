//! 测试策略：用来打通下单链路，不追求盈利。
//!
//! 页面提交一组参数，策略据此生成一个下单意图交给统一执行层：
//! - 方向可以手动指定做多/做空，也可以选「自动」：
//!   跟随最近一根已收盘的 1 分钟K线方向（收涨做多，收跌做空）。
//! - 开仓后由执行层挂好交易所端的止损、止盈，到期自动市价平仓。
//!
//! 新策略照着这个文件写：读取行情或指标 → 产出 [`OrderIntent`]。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::binance::{number, Binance, Endpoint};
use crate::trading::{OrderIntent, Side};

pub const ID: &str = "test";
pub const NAME: &str = "测试策略";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub symbol: String,
    /// long | short | auto
    pub direction: String,
    pub notional: f64,
    pub leverage: u32,
    pub stop_loss_percent: f64,
    pub take_profit_percent: f64,
    pub hold_minutes: u64,
}

pub async fn intent(binance: &Binance, request: Request) -> Result<OrderIntent, String> {
    let symbol = request.symbol.trim().to_ascii_uppercase();
    let (side, note) = match request.direction.as_str() {
        "long" => (Side::Long, "手动指定：做多".to_owned()),
        "short" => (Side::Short, "手动指定：做空".to_owned()),
        "auto" => follow_last_candle(binance, &symbol).await?,
        _ => return Err("方向只能是 long、short 或 auto。".into()),
    };
    Ok(OrderIntent {
        strategy_id: ID.into(),
        strategy_name: NAME.into(),
        symbol,
        side,
        notional: request.notional,
        leverage: request.leverage,
        stop_loss_percent: request.stop_loss_percent,
        take_profit_percent: request.take_profit_percent,
        max_hold_seconds: request.hold_minutes.saturating_mul(60),
        note,
    })
}

/// Follows the direction of the latest closed one-minute candle.
async fn follow_last_candle(binance: &Binance, symbol: &str) -> Result<(Side, String), String> {
    let rows: Vec<Vec<Value>> = binance
        .get(Endpoint::Klines, json!({"symbol": symbol, "interval": "1m", "limit": 2}))
        .await
        .map_err(|_| format!("无法读取 {symbol} 的 1 分钟K线。"))?;
    // The last row is the candle still forming; use the one before it.
    let candle = rows.len().checked_sub(2).and_then(|index| rows.get(index)).ok_or("K线数据不足。")?;
    let open = candle.get(1).and_then(number).ok_or("K线开盘价无效。")?;
    let close = candle.get(4).and_then(number).ok_or("K线收盘价无效。")?;
    let change = (close - open) / open * 100.0;
    let side = if close >= open { Side::Long } else { Side::Short };
    let label = if side == Side::Long { "做多" } else { "做空" };
    Ok((side, format!("自动：上一根 1 分钟K线 {change:+.3}% → {label}")))
}
