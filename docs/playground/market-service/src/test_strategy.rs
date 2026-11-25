//! 测试策略：用来打通下单链路，不追求盈利。
//!
//! 页面提交一组参数，策略据此生成一个下单意图交给统一执行层：
//! - 方向由用户指定做多或做空。
//! - 开仓后由执行层挂好交易所端的止损、止盈，到期自动市价平仓。
//!
//! 新策略照着这个文件写：读取行情或指标 → 产出 [`OrderIntent`]。

use serde::Deserialize;

use crate::trading::{OrderIntent, OrderSize, Side};

pub const ID: &str = "test";
pub const NAME: &str = "测试策略";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub account_revision: String,
    pub symbol: String,
    pub direction: Side,
    pub notional: f64,
    pub leverage: u32,
    pub stop_loss_percent: f64,
    pub take_profit_percent: f64,
    pub hold_minutes: u64,
}

impl Request {
    pub fn intent(self) -> OrderIntent {
        let note = match self.direction {
            Side::Long => "手动指定做多",
            Side::Short => "手动指定做空",
        };
        OrderIntent {
            strategy_id: ID.into(),
            strategy_name: NAME.into(),
            symbol: self.symbol.trim().to_ascii_uppercase(),
            side: self.direction,
            size: OrderSize::Notional(self.notional),
            leverage: self.leverage,
            stop_loss_percent: self.stop_loss_percent,
            take_profit_percent: self.take_profit_percent,
            limit_exit_percent: None,
            max_hold_seconds: self.hold_minutes.saturating_mul(60),
            note: note.into(),
        }
    }
}
