use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinSet};
use tokio_tungstenite::{
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

use crate::binance::{number, outbound_proxy, Binance, Contract, VOLUME_DELAY_MS};
use crate::notifications::{format_event, Notifier};
use crate::now_ms;
use crate::spike_trade::{observe_breakout, BreakoutObservation, Evaluation, Evaluator};
use crate::store::{Delivery, Result, Store};
use crate::strategy::{
    Detection, Move, PriceWindow, Rule, Sample, Volume, MARKET_SPIKE_NAME,
};
use crate::trading::Side;

const CHECK_LIMIT: usize = 100;
const CHECK_CONCURRENCY: usize = 2;
const MAX_QUEUE_AGE: i64 = 15_000;
const MAX_EVALUATIONS: usize = 16;
const MAX_BREAKOUT_OBSERVATIONS: usize = 4;
const MAX_WATCHES: usize = 20;
const WATCH_DURATION: i64 = 3_600_000;
type ObservationTask = (String, BreakoutObservation, Option<oneshot::Sender<BreakoutObservation>>);

enum Feed {
    Tickers(Vec<(String, Sample)>),
    Disconnected,
}

struct Check {
    contract: Contract,
    first: Move,
}

struct Watch {
    signal_time: i64,
    expires: i64,
    after: i64,
    quote: Option<(Sample, f64, f64)>,
}

impl Watch {
    fn snapshot(&self, symbol: &str, status: &str) -> Value {
        let quote = self.quote.map(|(sample, low, high)| json!({"time": sample.time, "price": sample.price, "low": low, "high": high}));
        json!({"symbol": symbol, "strategy": {"id": "market-spike", "name": MARKET_SPIKE_NAME},
            "time": self.signal_time, "status": status, "quote": quote})
    }
}

struct Monitor {
    store: Arc<Store>,
    binance: Arc<Binance>,
    notifier: Arc<Notifier>,
    owner: String,
    rule: Rule,
    version: i64,
    windows: HashMap<String, PriceWindow>,
    pending: VecDeque<Check>,
    checks: JoinSet<(Check, Volume)>,
    watches: HashMap<String, Watch>,
    contexts: JoinSet<(String, Value)>,
    context_queue: VecDeque<(String, String, i64)>,
    evaluator: Arc<Evaluator>,
    evaluations: JoinSet<Result<()>>,
    observation_binance: Arc<Binance>,
    observations: JoinSet<ObservationTask>,
}

pub async fn supervise(
    store: Arc<Store>,
    binance: Arc<Binance>,
    notifier: Arc<Notifier>,
    evaluator: Arc<Evaluator>,
    mut stop: watch::Receiver<bool>,
) {
    while !*stop.borrow() {
        let mut monitor = Monitor {
            store: Arc::clone(&store),
            binance: Arc::clone(&binance),
            owner: Uuid::new_v4().to_string(),
            notifier: Arc::clone(&notifier),
            rule: Rule::default(),
            version: 0,
            windows: HashMap::new(),
            pending: VecDeque::new(),
            checks: JoinSet::new(),
            watches: HashMap::new(),
            contexts: JoinSet::new(),
            context_queue: VecDeque::new(),
            evaluator: Arc::clone(&evaluator),
            evaluations: JoinSet::new(),
            observation_binance: Arc::new(Binance::new()),
            observations: JoinSet::new(),
        };
        if let Err(error) = monitor.run(&mut stop).await {
            eprintln!("Market monitor stopped: {error}");
        }
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
            _ = stop.changed() => {},
        }
    }
}

impl Monitor {
    async fn run(&mut self, stop: &mut watch::Receiver<bool>) -> Result<()> {
        let now = now_ms();
        if !self.store.heartbeat(&self.owner, "idle", now)? {
            return Ok(());
        }
        let result = async {
            self.store.reset_watches(&self.owner)?;
            self.store.interrupt_spikes(&self.owner)?;
            self.store.interrupt_spike_evaluations(&self.owner, true)?;
            self.store.interrupt_breakout_observations(&self.owner)?;
            self.event_loop(stop).await
        }
        .await;
        self.observations.shutdown().await;
        let interrupted = self.store.interrupt_spike_evaluations(&self.owner, false);
        while let Some(job) = self.evaluations.join_next().await {
            report_evaluation(job);
        }
        let cleanup = (|| {
            self.store.interrupt_spikes(&self.owner)?;
            self.store.interrupt_spike_evaluations(&self.owner, true)?;
            self.store.interrupt_breakout_observations(&self.owner)?;
            self.store.reset_watches(&self.owner)?;
            self.store.release(&self.owner)
        })();
        result.and(interrupted).and(cleanup)
    }

    async fn event_loop(&mut self, stop: &mut watch::Receiver<bool>) -> Result<()> {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut feeds = JoinSet::new();
        let mut feed: Option<AbortHandle> = None;
        let (tx, mut frames) = mpsc::channel(4);
        let mut directories = JoinSet::new();
        let mut deliveries = JoinSet::<(Delivery, &'static str)>::new();
        let mut contracts = HashMap::new();
        let mut next_directory = 0;
        let mut next_prune = 0;
        let mut connected = false;
        let mut generation = 0;
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                _ = interval.tick() => {
                    let now = now_ms();
                    let rule = self.store.rule()?;
                    let version = self.store.stop_version()?;
                    if !self.store.heartbeat(&self.owner, if !rule.enabled { "idle" } else if connected { "connected" } else { "connecting" }, now)? { break; }
                    if self.rule != rule || self.version != version {
                        if let Some(active) = feed.take() { active.abort(); }
                        generation += 1;
                        self.clear_window(false).await?;
                        connected = false;
                        if self.version != version || !rule.enabled { self.watches.clear(); }
                        self.rule = rule;
                        self.version = version;
                    }
                    if rule.enabled {
                        if feed.is_none() { feed = Some(feeds.spawn(watch_tickers(tx.clone(), generation))); }
                        if directories.is_empty() && now >= next_directory {
                            let binance = Arc::clone(&self.binance);
                            directories.spawn(async move { binance.directory(45_000).await });
                            next_directory = now + 60_000;
                        }
                        for row in self.store.signals()? {
                            if let (Some(id), Some(symbol), Some(time)) = (row["id"].as_str(), row["signal"]["symbol"].as_str(), row["signal"]["time"].as_i64()) {
                                self.start_watch(symbol, time)?;
                                self.store.finish_signal(id, &self.owner)?;
                            }
                        }
                        self.expire_watches(now)?;
                        if rule.notify && deliveries.is_empty() {
                            if let Some(delivery) = self.store.claim_delivery(now)? {
                                let notifier = Arc::clone(&self.notifier);
                                deliveries.spawn(async move {
                                    let status = match format_event(&delivery.event) {
                                        Some(message) => notifier.send(message).await,
                                        None => "invalid",
                                    };
                                    (delivery, status)
                                });
                            }
                        }
                    }
                    if now >= next_prune {
                        self.store.prune(now)?;
                        next_prune = now + WATCH_DURATION;
                    }
                }
                frame = frames.recv() => match frame {
                    Some((epoch, _)) if epoch != generation => {},
                    Some((_, Feed::Tickers(tickers))) => {
                        if !connected {
                            self.store.heartbeat(&self.owner, "connected", now_ms())?;
                            connected = true;
                        }
                        for (symbol, sample) in tickers {
                            if let Some(contract) = contracts.get(&symbol) {
                                self.observe(contract, sample)?;
                                self.quote_watch(&symbol, sample)?;
                            }
                        }
                    }
                    Some((_, Feed::Disconnected)) => { connected = false; self.clear_window(true).await?; }
                    None => break,
                },
                next = feeds.join_next_with_id(), if !feeds.is_empty() => {
                    if let Some(next) = next {
                        let id = match next { Ok((id, ())) => id, Err(error) => error.id() };
                        if feed.as_ref().is_some_and(|active| active.id() == id) { feed = None; }
                    }
                }
                updated = directories.join_next(), if !directories.is_empty() => match updated {
                    Some(Ok(Ok(directory))) => { contracts = directory.contracts.into_iter().map(|contract| (contract.id.clone(), contract)).collect(); }
                    _ => next_directory = now_ms() + 5_000,
                },
                task = self.checks.join_next(), if !self.checks.is_empty() => {
                    if let Some(Ok((check, volume))) = task { self.settle(check, Some(volume), "unavailable")?; }
                }
                task = self.contexts.join_next(), if !self.contexts.is_empty() => {
                    if let Some(Ok((id, context))) = task { self.store.save_context(&id, &context)?; }
                }
                task = self.evaluations.join_next(), if !self.evaluations.is_empty() => {
                    if let Some(job) = task { report_evaluation(job); }
                }
                task = self.observations.join_next(), if !self.observations.is_empty() => {
                    if let Some(Ok((id, observation, scoring))) = task {
                        self.store.finish_breakout_observation(&id, &self.owner, &json!(observation))?;
                        if let Some(scoring) = scoring { let _ = scoring.send(observation); }
                    }
                }
                delivery = deliveries.join_next(), if !deliveries.is_empty() => {
                    if let Some(Ok((job, status))) = delivery { self.store.finish_delivery(&job, status, now_ms())?; }
                }
            }
            self.drain_checks()?;
            if self.contexts.is_empty() {
                if let Some((id, symbol, time)) = self.context_queue.pop_front() {
                    let binance = Arc::clone(&self.binance);
                    self.contexts
                        .spawn(async move { (id, json!(binance.ratios(&symbol, time).await)) });
                }
            }
        }
        while let Some(Ok((job, status))) = deliveries.join_next().await {
            self.store.finish_delivery(&job, status, now_ms())?;
        }
        Ok(())
    }

    async fn clear_window(&mut self, keep_series: bool) -> Result<()> {
        self.checks.shutdown().await;
        self.pending.clear();
        self.windows.retain(|_, window| keep_series && window.has_confirmed_series());
        self.store.interrupt_spikes(&self.owner)
    }

    fn observe(&mut self, contract: &Contract, sample: Sample) -> Result<()> {
        let observation = self
            .windows
            .entry(contract.id.clone())
            .or_default()
            .observe(sample, self.rule);
        match observation {
            Some(Detection::CheckTurnover(first)) => {
                let check = Check { contract: contract.clone(), first };
                if self.pending.len() >= CHECK_LIMIT {
                    self.settle(check, None, "skipped")?;
                } else {
                    self.log_spike(
                        &contract.id, first, "pending", Some(self.rule.turnover_multiple), None,
                    )?;
                    self.pending.push_back(check);
                }
            }
            Some(Detection::Confirmed(next, volume)) => {
                self.confirm(contract, next, volume, None, None)?;
            }
            None => {}
        }
        Ok(())
    }

    fn drain_checks(&mut self) -> Result<()> {
        while self.checks.len() < CHECK_CONCURRENCY {
            let Some(check) = self.pending.pop_front() else {
                break;
            };
            let current = self.windows.get(&check.contract.id)
                .is_some_and(|window| window.has_pending_series(check.first.sample.time));
            if !current || now_ms() - check.first.sample.time > MAX_QUEUE_AGE {
                self.settle(check, None, "unavailable")?;
                continue;
            }
            let binance = Arc::clone(&self.binance);
            let seconds = self.rule.seconds;
            self.checks.spawn(async move {
                let time = check.first.sample.time;
                let delay = (time + VOLUME_DELAY_MS - now_ms()).max(0) as u64;
                tokio::time::sleep(Duration::from_millis(delay)).await;
                let volume = binance
                    .compare_turnover(&check.contract, time + 1, seconds)
                    .await;
                (check, volume)
            });
        }
        Ok(())
    }

    fn settle(
        &mut self,
        check: Check,
        volume: Option<Volume>,
        unavailable_status: &str,
    ) -> Result<()> {
        let timely = now_ms() - check.first.sample.time <= MAX_QUEUE_AGE + 10_000;
        let multiple = volume.and_then(|volume| volume.multiple);
        let passed = volume.filter(|_| {
            timely && multiple.is_some_and(|multiple| multiple >= self.rule.turnover_multiple)
        });
        let symbol = &check.contract.id;
        let first_time = check.first.sample.time;
        let current = self.windows.get(symbol).is_some_and(|window| window.has_pending_series(first_time));
        let required = Some(self.rule.turnover_multiple);
        let confirmation = if let Some(confirmed_volume) = passed.filter(|_| current) {
            self.confirm(&check.contract, check.first, confirmed_volume, required, Some(first_time))?
                .map(|confirmed_at| (confirmed_volume, confirmed_at))
        } else {
            None
        };
        if let Some(window) = self.windows.get_mut(symbol) {
            window.settle(first_time, self.rule.observation, confirmation);
        }
        if confirmation.is_none() {
            let status = if !current || passed.is_some() {
                "interrupted"
            } else if timely && multiple.is_some() {
                "below-threshold"
            } else {
                unavailable_status
            };
            self.log_spike(symbol, check.first, status, required, volume)?;
        }
        Ok(())
    }

    fn event(&self, symbol: &str, movement: Move) -> Value {
        let mut event = json!({"symbol":symbol,"time":movement.sample.time,"level":movement.level,"seconds":self.rule.seconds,
            "previous":movement.previous,"originalReference":movement.original_reference,
            "price":movement.sample.price,"change":movement.change,"threshold":movement.threshold,
            "roundId":round_id(symbol, movement)});
        if let Some(minutes) = movement.observation_minutes {
            event["observationMinutes"] = json!(minutes);
        }
        event
    }

    fn log_spike(
        &self,
        symbol: &str,
        movement: Move,
        status: &str,
        required: Option<f64>,
        volume: Option<Volume>,
    ) -> Result<()> {
        let mut spike = self.event(symbol, movement);
        spike["status"] = json!(status);
        spike["requiredMultiple"] = json!(required);
        if let Some(volume) = volume {
            spike["volume"] = json!(volume);
        }
        self.store.record_spike(&spike)
    }

    fn confirm(
        &mut self,
        contract: &Contract,
        movement: Move,
        volume: Volume,
        required: Option<f64>,
        series_trigger_time: Option<i64>,
    ) -> Result<Option<i64>> {
        let symbol = &contract.id;
        let mut event = self.event(symbol, movement);
        let threshold = movement.threshold;
        let time = movement.sample.time;
        let id = format!(
            "market-spike:{symbol}:{time}:{}:{threshold}:{}",
            self.rule.seconds, movement.level
        );
        event["kind"] = json!("market-spike");
        event["volume"] = json!(volume);
        let evaluate = series_trigger_time.filter(|_| volume.multiple.is_some());
        let can_queue = self.evaluations.len() < MAX_EVALUATIONS;
        let can_observe = self.observations.len() < MAX_BREAKOUT_OBSERVATIONS;
        if evaluate.is_some() {
            event["continuation"] = json!({"status":if can_queue { "pending" } else { "queue-skipped" }});
            event["breakoutObservation"] = json!(if can_observe {
                BreakoutObservation::Pending
            } else {
                BreakoutObservation::QueueSkipped
            });
        }
        let confirmed_at = now_ms();
        if self
            .store
            .confirm(&id, &event, self.rule, &self.owner, self.version, confirmed_at)?
        {
            self.log_spike(
                symbol,
                movement,
                "alerted",
                required,
                Some(volume),
            )?;
            let (scoring, observation) = (evaluate.is_some() && can_queue && can_observe)
                .then(oneshot::channel)
                .unzip();
            if let Some(trigger_time) = evaluate.filter(|_| can_queue) {
                let evaluator = Arc::clone(&self.evaluator);
                let evaluation = Evaluation {
                    id: id.clone(), round_id: round_id(symbol, movement), contract: contract.clone(), trigger_time, volume, observation,
                    side: if threshold > 0.0 { Side::Long } else { Side::Short },
                    rule: self.rule, owner: self.owner.clone(),
                };
                self.evaluations.spawn(async move { evaluator.evaluate(evaluation).await });
            }
            if evaluate.is_some() && can_observe {
                let binance = Arc::clone(&self.observation_binance);
                let alert_id = id.clone();
                let symbol = symbol.to_owned();
                self.observations.spawn(async move {
                    let observed = observe_breakout(&binance, &symbol, movement, threshold > 0.0).await;
                    (alert_id, observed, scoring)
                });
            }
            self.start_watch(symbol, time)?;
            self.store.finish_signal(&id, &self.owner)?;
            if self.context_queue.len() < CHECK_LIMIT {
                self.context_queue.push_back((id, symbol.to_owned(), time));
            } else {
                self.store.save_context(&id, &json!("queue-skipped"))?;
            }
            return Ok(Some(confirmed_at));
        }
        Ok(None)
    }

    fn start_watch(&mut self, symbol: &str, time: i64) -> Result<()> {
        let now = now_ms();
        let after = self
            .windows
            .get(symbol)
            .and_then(PriceWindow::latest)
            .map_or(time, |sample| sample.time);
        let watch = Watch {
            signal_time: time,
            expires: now + WATCH_DURATION,
            after,
            quote: None,
        };
        if let Some(current) = self.watches.get_mut(symbol) {
            if current.signal_time >= time {
                return Ok(());
            }
            current.signal_time = time;
            current.expires = watch.expires;
            return self.store.save_watch(
                &current.snapshot(
                    symbol,
                    if current.quote.is_some() {
                        "watching"
                    } else {
                        "starting"
                    },
                ),
                &self.owner,
                self.version,
            );
        }
        if self.watches.len() >= MAX_WATCHES {
            let mut failed = watch.snapshot(symbol, "failed");
            failed["failure"] = json!("capacity");
            return self.store.save_watch(&failed, &self.owner, self.version);
        }
        self.store.save_watch(
            &watch.snapshot(symbol, "starting"),
            &self.owner,
            self.version,
        )?;
        self.watches.insert(symbol.to_owned(), watch);
        Ok(())
    }

    fn quote_watch(&mut self, symbol: &str, sample: Sample) -> Result<()> {
        let Some(watch) = self
            .watches
            .get_mut(symbol)
            .filter(|watch| sample.time > watch.after)
        else {
            return Ok(());
        };
        let (_, low, high) = watch.quote.unwrap_or((sample, sample.price, sample.price));
        watch.quote = Some((sample, low.min(sample.price), high.max(sample.price)));
        watch.after = sample.time;
        self.store.save_watch(
            &watch.snapshot(symbol, "watching"),
            &self.owner,
            self.version,
        )
    }

    fn expire_watches(&mut self, now: i64) -> Result<()> {
        let expired: Vec<_> = self
            .watches
            .iter()
            .filter(|(_, watch)| watch.expires <= now)
            .map(|(symbol, _)| symbol.clone())
            .collect();
        for symbol in expired {
            if let Some(watch) = self.watches.remove(&symbol) {
                self.store.save_watch(
                    &watch.snapshot(&symbol, "finished"),
                    &self.owner,
                    self.version,
                )?;
            }
        }
        Ok(())
    }
}

fn round_id(symbol: &str, movement: Move) -> String {
    format!("{symbol}:{}:{}", movement.threshold.signum(), movement.first_trigger_time)
}

fn report_evaluation(job: std::result::Result<Result<()>, tokio::task::JoinError>) {
    match job {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Market spike evaluation failed: {error}"),
        Err(error) => eprintln!("Market spike evaluation worker failed: {error}"),
    }
}

const MARKET_HOST: &str = "fstream.binance.com";
const MARKET_STREAM: &str = "wss://fstream.binance.com/market/ws/!miniTicker@arr";
const MAX_MARKET_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
type MarketSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn watch_tickers(tx: mpsc::Sender<(u64, Feed)>, generation: u64) {
    loop {
        // Read the original exchange frame. The generated Pro venue wrappers
        // currently fail to dispatch this stream and can overflow the stack.
        if let Ok(Ok(mut connection)) =
            tokio::time::timeout(Duration::from_secs(10), connect_market_stream()).await
        {
            while let Ok(Some(tickers)) =
                tokio::time::timeout(Duration::from_secs(15), next_market_frame(&mut connection))
                    .await
            {
                let now = now_ms();
                let ticks = tickers
                    .iter()
                    .filter_map(|ticker| ticker_sample(ticker, now))
                    .collect();
                if tx.send((generation, Feed::Tickers(ticks))).await.is_err() {
                    return;
                }
            }
        }
        if tx.send((generation, Feed::Disconnected)).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn connect_market_stream() -> Result<MarketSocket> {
    let config = Some(WebSocketConfig {
        max_message_size: Some(MAX_MARKET_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MARKET_MESSAGE_BYTES),
        ..WebSocketConfig::default()
    });
    let Some(proxy) = outbound_proxy().filter(|_| !no_proxy_market_host()) else {
        return Ok(
            tokio_tungstenite::connect_async_with_config(MARKET_STREAM, config, false)
                .await?
                .0,
        );
    };
    let proxy = reqwest::Url::parse(&proxy)?;
    if proxy.scheme() != "http" || !proxy.username().is_empty() || proxy.password().is_some() {
        return Err("The market WebSocket requires a direct connection or an unauthenticated HTTP CONNECT proxy".into());
    }
    let mut tunnel = TcpStream::connect((
        proxy.host_str().ok_or("Missing proxy host")?,
        proxy.port_or_known_default().ok_or("Missing proxy port")?,
    ))
    .await?;
    tunnel
        .write_all(
            format!("CONNECT {MARKET_HOST}:443 HTTP/1.1\r\nHost: {MARKET_HOST}:443\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    let mut reply = Vec::with_capacity(512);
    while !reply.ends_with(b"\r\n\r\n") {
        if reply.len() == 8_192 {
            return Err("Invalid HTTP CONNECT response".into());
        }
        reply.push(tunnel.read_u8().await?);
    }
    let status = std::str::from_utf8(&reply)?
        .lines()
        .next()
        .and_then(|line| line.split_ascii_whitespace().nth(1));
    if status != Some("200") {
        return Err("HTTP CONNECT proxy rejected the market WebSocket".into());
    }
    Ok(
        tokio_tungstenite::client_async_tls_with_config(MARKET_STREAM, tunnel, config, None)
            .await?
            .0,
    )
}

fn no_proxy_market_host() -> bool {
    std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .is_ok_and(|entries| {
            entries.split(',').map(str::trim).any(|entry| {
                let domain = entry
                    .strip_suffix(":443")
                    .unwrap_or(entry)
                    .trim_start_matches('.');
                domain == "*"
                    || MARKET_HOST.eq_ignore_ascii_case(domain)
                    || MARKET_HOST
                        .strip_suffix(domain)
                        .is_some_and(|prefix| prefix.ends_with('.'))
            })
        })
}

async fn next_market_frame(socket: &mut MarketSocket) -> Option<Vec<Value>> {
    while let Some(frame) = socket.next().await {
        match frame.ok()? {
            Message::Text(text) => {
                if let Ok(ticks) = serde_json::from_str(&text) {
                    return Some(ticks);
                }
            }
            Message::Ping(_) => socket.flush().await.ok()?,
            Message::Close(_) => return None,
            _ => {}
        }
    }
    None
}

fn ticker_sample(raw: &Value, now: i64) -> Option<(String, Sample)> {
    if raw["e"] != "24hrMiniTicker" || raw["st"].as_i64() == Some(2) {
        return None;
    }
    let time = raw["E"].as_i64()?;
    let price = number(&raw["c"])?;
    if !(now - 15_000..=now + 5_000).contains(&time) || !price.is_finite() || price <= 0.0 {
        return None;
    }
    Some((raw["s"].as_str()?.to_owned(), Sample { time, price }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_raw_mini_ticker_and_filters_coin_margin() {
        let packet =
            |kind| json!({"e":"24hrMiniTicker","s":"BTCUSDT","E":50_000,"st":kind,"c":"102.5"});
        assert_eq!(
            ticker_sample(&packet(1), 60_000),
            Some((
                "BTCUSDT".into(),
                Sample {
                    time: 50_000,
                    price: 102.5
                }
            ))
        );
        assert!(ticker_sample(&packet(2), 60_000).is_none());
        assert!(ticker_sample(&packet(1), 70_000).is_none());
    }
}
