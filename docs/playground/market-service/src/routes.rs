use std::sync::Arc;
use std::time::Duration;

use axum::extract::{rejection::JsonRejection, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::binance::{number, Binance, Endpoint, VOLUME_DELAY_MS};
use crate::markets::{Exchange, Kind, MarketError, Markets};
use crate::notifications::{format_event, Notifier};
use crate::now_ms;
use crate::store::Store;
use crate::strategy::{Rule, MAX_WINDOW_SECONDS, MIN_WINDOW_SECONDS};
use crate::trading::Trader;

const DAY_MS: i64 = 86_400_000;
const BEIJING_OFFSET_MS: i64 = 28_800_000;

#[derive(Clone)]
struct Service {
    binance: Arc<Binance>,
    markets: Arc<Markets>,
    store: Option<Arc<Store>>,
    notifier: Arc<Notifier>,
    liquidation: Arc<crate::liquidation::Loader>,
    research: Arc<crate::research::Research>,
    holders: Arc<crate::holders::Holders>,
    trader: Option<Arc<Trader>>,
}

pub fn router(
    binance: Arc<Binance>,
    store: Option<Arc<Store>>,
    notifier: Arc<Notifier>,
    trader: Option<Arc<Trader>>,
    token: Option<Arc<str>>,
) -> crate::store::Result<Router> {
    let markets = Arc::new(Markets::new(Arc::clone(&binance))?);
    let research = Arc::new(crate::research::Research::new(Arc::clone(&markets))?);
    let liquidation = Arc::new(crate::liquidation::Loader::new(
        Arc::clone(&markets),
        Arc::clone(&research),
    )?);
    let holders = Arc::new(crate::holders::Holders::new(
        Arc::clone(&markets),
        Arc::clone(&research),
    ));
    let local = Router::new()
        .route(
            "/api/markets/background-monitor",
            get(monitor_status).put(monitor_rule).delete(monitor_delete),
        )
        .route(
            "/api/strategy-notifications",
            get(notification_status)
                .put(notification_settings)
                .post(notification_send),
        )
        .route("/api/trading", get(trading_status))
        .route("/api/trading/test-order", post(trading_test_order))
        .route("/api/trading/close", post(trading_close))
        .route_layer(middleware::from_fn_with_state(token, require_local_token));
    Ok(Router::new()
        .route("/health", get(|| async { StatusCode::NO_CONTENT }))
        .route("/api/markets/contracts", get(contracts))
        .route("/api/markets/contract-market-caps", get(contract_caps))
        .route("/api/markets/fundamentals", get(fundamentals))
        .route("/api/markets/holders", get(holders_route))
        .route("/api/markets/alert-context", get(alert_context))
        .route("/api/markets/directory", get(directory))
        .route("/api/markets/ticker", get(ticker))
        .route("/api/markets/order-book", get(order_book))
        .route("/api/markets/funding-rates", get(funding_rates))
        .route("/api/markets/volume", get(volume))
        .route("/api/markets/liquidations", get(liquidations))
        .merge(local)
        .with_state(Service {
            binance,
            markets,
            store,
            notifier,
            liquidation,
            research,
            holders,
            trader,
        }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketQuery {
    exchange: Option<String>,
    market: Option<String>,
    symbol: Option<String>,
    closed_marks: Option<String>,
    view: Option<String>,
}

impl MarketQuery {
    fn exchange(&self) -> Option<Exchange> {
        match self.exchange.as_deref() {
            None | Some("binance") => Some(Exchange::Binance),
            Some("okx") => Some(Exchange::Okx),
            _ => None,
        }
    }

    fn kind(&self) -> Option<Kind> {
        match self.market.as_deref() {
            None | Some("futures") => Some(Kind::Futures),
            Some("spot") => Some(Kind::Spot),
            Some("alpha") => Some(Kind::Alpha),
            _ => None,
        }
    }

    fn symbol(&self) -> Option<&str> {
        self.symbol
            .as_deref()
            .filter(|symbol| !symbol.is_empty() && symbol.encode_utf16().count() <= 80)
    }
}

async fn directory(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some(exchange) = query.exchange() else {
        return error(StatusCode::BAD_REQUEST, "未知的交易平台。");
    };
    no_store(Json(state.markets.directory(exchange).await).into_response())
}

async fn contract_caps(State(state): State<Service>) -> Response {
    match state.research.contract_caps().await {
        Ok(value) => no_store(Json(value).into_response()),
        Err(_) => error(StatusCode::BAD_GATEWAY, "暂时无法同步合约流通市值。"),
    }
}

async fn fundamentals(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some(symbol) = query.symbol() else {
        return error(StatusCode::BAD_REQUEST, "请选择币安合约。");
    };
    let result = match state
        .markets
        .instrument(Exchange::Binance, Kind::Futures, symbol)
        .await
    {
        Ok(pair) => state.research.overview(&pair).await,
        Err(error) => Err(error),
    };
    market_response(result, "该合约已不在目录中。", "币种资料暂时无法同步。")
}

async fn holders_route(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some(symbol) = query.symbol().filter(|symbol| {
        symbol
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    }) else {
        return error(StatusCode::BAD_REQUEST, "请选择币安 USDT 永续合约。");
    };
    let result = match state
        .markets
        .instrument(Exchange::Binance, Kind::Futures, symbol)
        .await
    {
        Ok(pair) => Ok(state.holders.response(&pair).await),
        Err(error) => Err(error),
    };
    market_response(result, "找不到此合约。", "暂时无法获取持币地址资料。")
}

async fn ticker(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some(((exchange, kind), symbol)) = query.exchange().zip(query.kind()).zip(query.symbol())
    else {
        return error(StatusCode::BAD_REQUEST, "请从列表选择一个交易对。");
    };
    market_response(
        state.markets.ticker(exchange, kind, symbol).await,
        "这个交易对已不在可交易列表中，请重新选择。",
        "暂时无法取得行情，请稍后重试。",
    )
}

async fn order_book(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some((exchange, symbol)) = query.exchange().zip(query.symbol()) else {
        return error(StatusCode::BAD_REQUEST, "请选择永续合约。");
    };
    market_response(
        state.markets.book(exchange, symbol).await,
        "找不到该永续合约。",
        "订单簿暂不可用。",
    )
}

async fn funding_rates(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some((exchange, symbol)) = query.exchange().zip(query.symbol()) else {
        return error(StatusCode::BAD_REQUEST, "请选择永续合约。");
    };
    market_response(
        state.markets.funding(exchange, symbol).await,
        "找不到该永续合约。",
        "资金费率暂不可用。",
    )
}

async fn liquidations(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some(symbol) = query.symbol() else {
        return error(StatusCode::BAD_REQUEST, "请选择币安合约。");
    };
    if query.closed_marks.as_deref() != Some("1") {
        use crate::liquidation::{LoadError, HISTORY_UNAVAILABLE, MARGIN_UNAVAILABLE};
        let unavailable = || error(StatusCode::BAD_GATEWAY, "币安强平风险图暂不可用。");
        let pair = match state
            .markets
            .instrument(Exchange::Binance, Kind::Futures, symbol)
            .await
        {
            Ok(pair) => pair,
            Err(MarketError::Missing) => return error(StatusCode::NOT_FOUND, "找不到该币安合约。"),
            Err(_) => return unavailable(),
        };
        return match state.liquidation.levels(&pair).await {
            Ok(model) => no_store(Json(model).into_response()),
            Err(LoadError::History) => error(StatusCode::BAD_GATEWAY, HISTORY_UNAVAILABLE),
            Err(LoadError::Margin) => error(StatusCode::SERVICE_UNAVAILABLE, MARGIN_UNAVAILABLE),
            Err(LoadError::Upstream) => unavailable(),
        };
    }
    let unavailable = || error(StatusCode::BAD_GATEWAY, "币安标记价 K 线暂不可用。");
    match state.binance.contract(symbol).await {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "找不到该币安合约。"),
        Err(_) => return unavailable(),
    }
    let step = 5 * 60_000;
    let boundary = now_ms().div_euclid(step) * step;
    let rows: Result<Vec<Vec<Value>>, _> = state
        .binance
        .get(
            Endpoint::MarkKlines,
            json!({"symbol": symbol, "interval": "5m", "limit": 49, "endTime": boundary - 1}),
        )
        .await;
    let Ok(rows) = rows else {
        return unavailable();
    };
    let bars: Vec<_> =
        rows.iter()
            .filter_map(|row| {
                let time = row.first()?.as_i64()?;
                let open = number(row.get(1)?)?;
                let high = number(row.get(2)?)?;
                let low = number(row.get(3)?)?;
                let close = number(row.get(4)?)?;
                (time % step == 0
                && time <= boundary - step
                && low > 0.0
                && high >= low
            && (low..=high).contains(&close) && (low..=high).contains(&open))
            .then(|| json!({"time": time, "open": open, "high": high, "low": low, "close": close}))
            })
            .collect();
    no_store(Json(bars).into_response())
}

fn market_response(
    result: Result<Value, MarketError>,
    missing: &str,
    unavailable: &str,
) -> Response {
    match result {
        Ok(value) => no_store(Json(value).into_response()),
        Err(MarketError::Missing) => error(StatusCode::NOT_FOUND, missing),
        Err(MarketError::RateLimit) => error(
            StatusCode::TOO_MANY_REQUESTS,
            "交易所暂时限制了请求频率，请稍后重试。",
        ),
        Err(MarketError::Unavailable) => error(StatusCode::BAD_GATEWAY, unavailable),
    }
}

async fn volume(State(state): State<Service>, Query(query): Query<MarketQuery>) -> Response {
    let Some(((exchange, kind), symbol)) = query.exchange().zip(query.kind()).zip(query.symbol())
    else {
        return error(StatusCode::BAD_REQUEST, "请从列表选择一个交易对。");
    };
    let result = match state.markets.instrument(exchange, kind, symbol).await {
        Ok(pair) => crate::volume::response(&state.markets, &pair, query.view.as_deref()).await,
        Err(error) => Err(error),
    };
    if matches!(result, Err(MarketError::RateLimit)) {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "交易所暂时限制了请求频率，稍后会自动重试。",
        );
    }
    market_response(
        result,
        "这个交易对已不在可交易列表中。",
        "暂时无法取得成交额，稍后会自动重试。",
    )
}

async fn contracts(State(Service { binance, .. }): State<Service>) -> Response {
    match binance.directory(0).await {
        Ok(directory) => no_store(Json(directory).into_response()),
        Err(_) => error(StatusCode::BAD_GATEWAY, "暂时无法同步币安合约列表。"),
    }
}

#[derive(Deserialize)]
struct AlertQuery {
    symbol: Option<String>,
    view: Option<String>,
    seconds: Option<String>,
    time: Option<String>,
}

async fn alert_context(
    State(Service { binance, .. }): State<Service>,
    Query(query): Query<AlertQuery>,
) -> Response {
    let invalid = || error(StatusCode::BAD_REQUEST, "无效的告警参数。");
    let Some(symbol) = query
        .symbol
        .as_deref()
        .filter(|symbol| valid_symbol(symbol))
    else {
        return invalid();
    };
    let Some(time) = query
        .time
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
    else {
        return invalid();
    };
    let now = now_ms();
    if query.view.as_deref() == Some("day-open") {
        if time <= 0 || time > now || (time + BEIJING_OFFSET_MS).rem_euclid(DAY_MS) != 0 {
            return invalid();
        }
        return match binance
            .day_open(symbol, time, (time + DAY_MS - 1).min(now))
            .await
        {
            Ok(open) => {
                let mut response = Json(json!({"open": open})).into_response();
                if open.is_some() {
                    response.headers_mut().insert(
                        header::CACHE_CONTROL,
                        HeaderValue::from_static("private, max-age=86400"),
                    );
                }
                response
            }
            Err(_) => error(StatusCode::BAD_GATEWAY, "暂时无法取得告警行情。"),
        };
    }
    let turnover_view = query.view.as_deref() == Some("turnover");
    let minimum = if turnover_view { MIN_WINDOW_SECONDS } else { 1 };
    let Some(seconds) = query
        .seconds
        .as_deref()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|seconds| (minimum..=MAX_WINDOW_SECONDS).contains(seconds))
    else {
        return invalid();
    };
    if !(now - 3_600_000..=now + 5_000).contains(&time) {
        return invalid();
    }
    let contract = match binance.contract(symbol).await {
        Ok(Some(contract)) => contract,
        Ok(None) => return error(StatusCode::NOT_FOUND, "找不到此合约。"),
        Err(_) => return error(StatusCode::BAD_GATEWAY, "暂时无法取得告警行情。"),
    };
    if turnover_view {
        let delay = time + VOLUME_DELAY_MS - now_ms();
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
        }
        let volume = binance.compare_turnover(&contract, time + 1, seconds).await;
        return no_store(
            Json(json!({"turnover": volume.turnover, "baseline": volume.baseline})).into_response(),
        );
    }
    let (mut context, turnover) = tokio::join!(binance.ratios(symbol, time), async {
        if query.view.as_deref() == Some("ratios") {
            None
        } else {
            binance
                .turnover(&contract, time - i64::from(seconds) * 1_000, time + 1)
                .await
        }
    });
    context.turnover = turnover;
    no_store(Json(context).into_response())
}

async fn require_local_token(
    State(token): State<Option<Arc<str>>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if headers.get(header::ORIGIN).is_none()
        && token
            .as_deref()
            .zip(provided)
            .is_some_and(|(expected, provided)| {
                bool::from(expected.as_bytes().ct_eq(provided.as_bytes()))
            })
    {
        return next.run(request).await;
    }
    if request.uri().path() == "/api/strategy-notifications" {
        return notification_response(StatusCode::FORBIDDEN, "forbidden");
    }
    no_store(error(
        StatusCode::FORBIDDEN,
        "后台监控仅在本地设置模式下可管理。",
    ))
}

async fn monitor_status(State(state): State<Service>) -> Response {
    let Some(store) = state.store else {
        return error(StatusCode::FORBIDDEN, "后台监控仅在本地设置模式下可管理。");
    };
    store_response(move || store.status(now_ms()), "无法读取后台监控记录。").await
}

async fn monitor_rule(
    State(state): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Some(store) = state.store else {
        return error(StatusCode::FORBIDDEN, "当前请求无法修改后台监控设置。");
    };
    if !has_json(&headers) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "需要 JSON 规则。");
    }
    if body_too_large(&body) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "请求体过大。");
    }
    let rule = body.ok().and_then(|Json(value)| {
        if value.get("up").is_none() || value.get("down").is_none() {
            return None;
        }
        serde_json::from_value::<Rule>(value)
            .ok()
            .filter(|rule| rule.is_valid())
    });
    let Some(rule) = rule else {
        return error(
            StatusCode::BAD_REQUEST,
            "请检查时间窗口、涨跌幅和成交额倍数。",
        );
    };
    store_response(
        move || {
            store.save_rule(rule)?;
            store.status(now_ms())
        },
        "无法保存后台监控设置。",
    )
    .await
}

async fn monitor_delete(
    State(state): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Some(store) = state.store else {
        return error(StatusCode::FORBIDDEN, "当前请求无法删除监控记录。");
    };
    if !has_json(&headers) {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "需要 JSON 格式的监控记录。",
        );
    }
    if body_too_large(&body) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "请求体过大。");
    }
    let body = body.map(|Json(value)| value).unwrap_or_default();
    if let Some(watches) = body.get("autoOrderWatches") {
        let Some(rows) = watches
            .as_array()
            .filter(|rows| {
                !rows.is_empty()
                    && rows.iter().all(|row| {
                        text_within(&row["symbol"], 80)
                            && text_within(&row["strategy"]["id"], 80)
                            && valid_record_time(&row["time"])
                    })
            })
            .cloned()
        else {
            return error(StatusCode::BAD_REQUEST, "请选择有效的自动下单任务记录。");
        };
        return store_response(
            move || {
                store.delete_watches(&rows)?;
                store.status(now_ms())
            },
            "无法删除自动下单任务记录。",
        )
        .await;
    }
    let Some(rows) = body
        .as_array()
        .filter(|rows| {
            !rows.is_empty()
                && rows.len() <= 100
                && rows.iter().all(|row| {
                    text_within(&row["symbol"], 64)
                        && valid_record_time(&row["time"])
                        && row["threshold"].as_f64().is_some()
                })
        })
        .cloned()
    else {
        return error(StatusCode::BAD_REQUEST, "请选择有效的告警记录。");
    };
    store_response(
        move || {
            store.delete_spikes(&rows)?;
            store.status(now_ms())
        },
        "无法删除告警记录。",
    )
    .await
}

async fn notification_status(State(state): State<Service>) -> Response {
    notification_response(StatusCode::OK, state.notifier.status())
}

async fn notification_settings(
    State(state): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if !has_json(&headers) {
        return notification_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid-event");
    }
    if body_too_large(&body) {
        return notification_response(StatusCode::PAYLOAD_TOO_LARGE, "invalid-event");
    }
    let change = body.map(|Json(value)| value).unwrap_or_default();
    let status = state.notifier.save(&change).await;
    let code = match status {
        "ready" | "paused" => StatusCode::OK,
        "config-unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    notification_response(code, status)
}

async fn notification_send(
    State(state): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if !has_json(&headers) {
        return notification_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid-event");
    }
    if body_too_large(&body) {
        return notification_response(StatusCode::PAYLOAD_TOO_LARGE, "invalid-event");
    }
    let event = body.map(|Json(value)| value).unwrap_or_default();
    let Some(message) = format_event(&event) else {
        return notification_response(StatusCode::BAD_REQUEST, "invalid-event");
    };
    let status = state.notifier.send(message).await;
    let code = match status {
        "invalid" | "config-unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        "rate-limited" => StatusCode::TOO_MANY_REQUESTS,
        "failed" => StatusCode::BAD_GATEWAY,
        _ => StatusCode::OK,
    };
    notification_response(code, status)
}

async fn trading_status(State(state): State<Service>) -> Response {
    let Some(trader) = state.trader else {
        return no_store(error(StatusCode::FORBIDDEN, "下单仅在本地设置模式下可用。"));
    };
    no_store(Json(trader.status().await).into_response())
}

async fn trading_test_order(
    State(state): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Some(trader) = state.trader else {
        return no_store(error(StatusCode::FORBIDDEN, "下单仅在本地设置模式下可用。"));
    };
    if !has_json(&headers) {
        return no_store(error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "需要 JSON 格式的下单参数。"));
    }
    if body_too_large(&body) {
        return no_store(error(StatusCode::PAYLOAD_TOO_LARGE, "请求体过大。"));
    }
    let Some(request) = body
        .ok()
        .and_then(|Json(value)| serde_json::from_value::<crate::test_strategy::Request>(value).ok())
    else {
        return no_store(error(StatusCode::BAD_REQUEST, "请检查交易对、方向、金额、杠杆、止损止盈和持仓时间。"));
    };
    let result = match crate::test_strategy::intent(&state.binance, request).await {
        Ok(intent) => trader.submit(intent).await,
        Err(message) => Err(message),
    };
    trading_response(result)
}

async fn trading_close(
    State(state): State<Service>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Some(trader) = state.trader else {
        return no_store(error(StatusCode::FORBIDDEN, "下单仅在本地设置模式下可用。"));
    };
    if !has_json(&headers) {
        return no_store(error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "需要 JSON 格式的请求。"));
    }
    let id = body.ok().and_then(|Json(value)| value["tradeId"].as_str().map(str::to_owned));
    let Some(id) = id.filter(|id| text_within(&json!(id), 200)) else {
        return no_store(error(StatusCode::BAD_REQUEST, "请选择要平仓的交易。"));
    };
    trading_response(trader.close(&id).await)
}

fn trading_response(result: Result<Value, String>) -> Response {
    match result {
        Ok(trade) => no_store(Json(json!({"trade": trade})).into_response()),
        Err(message) => no_store(error(StatusCode::UNPROCESSABLE_ENTITY, &message)),
    }
}

fn notification_response(code: StatusCode, status: &str) -> Response {
    no_store((code, Json(json!({"status":status}))).into_response())
}

fn has_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn body_too_large(body: &Result<Json<Value>, JsonRejection>) -> bool {
    body.as_ref()
        .is_err_and(|error| error.status() == StatusCode::PAYLOAD_TOO_LARGE)
}

fn text_within(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.is_empty() && text.encode_utf16().count() <= max)
}

fn valid_record_time(value: &Value) -> bool {
    value
        .as_i64()
        .is_some_and(|time| (1..=8_640_000_000_000_000).contains(&time))
}

async fn store_response(
    work: impl FnOnce() -> crate::store::Result<Value> + Send + 'static,
    failure: &str,
) -> Response {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => no_store(Json(value).into_response()),
        _ => no_store(error(StatusCode::SERVICE_UNAVAILABLE, failure)),
    }
}

pub(crate) fn valid_symbol(symbol: &str) -> bool {
    let mut letters = symbol.chars();
    letters.next().is_some_and(char::is_alphanumeric)
        && symbol.encode_utf16().count() <= 80
        && letters.all(|letter| letter.is_alphanumeric() || letter == '_' || letter == '-')
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Method;
    use tower::ServiceExt;

    #[tokio::test]
    async fn internal_routes_require_a_server_token_before_reading_json() {
        let token: Arc<str> = "a".repeat(64).into();
        let app = router(
            Arc::new(Binance::new()),
            None,
            Arc::new(Notifier::new(false).unwrap()),
            None,
            Some(token.clone()),
        )
        .unwrap();
        let notification = "/api/strategy-notifications";
        let monitor = "/api/markets/background-monitor";
        let call = |path, method, authorization: Option<&str>, origin: Option<&str>| {
            let mut request = axum::http::Request::builder()
                .uri(path)
                .method(method)
                .header(header::HOST, "127.0.0.1")
                .header(header::CONTENT_TYPE, "application/json");
            if let Some(authorization) = authorization {
                request = request.header(header::AUTHORIZATION, format!("Bearer {authorization}"));
            }
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            app.clone().oneshot(request.body(Body::from("{")).unwrap())
        };
        for (path, method) in [
            (notification, Method::GET),
            (notification, Method::PUT),
            (notification, Method::POST),
            (monitor, Method::GET),
            (monitor, Method::PUT),
            (monitor, Method::DELETE),
            ("/api/trading", Method::GET),
            ("/api/trading/test-order", Method::POST),
            ("/api/trading/close", Method::POST),
        ] {
            assert_eq!(
                call(path, method, None, None).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            call(notification, Method::POST, Some(&"b".repeat(64)), None)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                notification,
                Method::POST,
                Some(&token),
                Some("http://127.0.0.1")
            )
            .await
            .unwrap()
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(notification, Method::POST, Some(&token), None)
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call("/health", Method::GET, None, None)
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }
}
