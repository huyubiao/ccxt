mod binance;
mod holders;
mod liquidation;
mod markets;
mod monitor;
mod notifications;
mod research;
mod routes;
mod store;
mod strategy;
mod test_strategy;
mod tokenomics;
mod trading;
mod volume;

use std::io::Write;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::net::TcpListener;

const HTTP_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

#[tokio::main]
async fn main() -> store::Result<()> {
    let address = std::env::var("PLAYGROUND_MARKET_SERVICE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3101".to_owned());
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let local_settings = std::env::var("PLAYGROUND_LOCAL_SETTINGS").as_deref() == Ok("1");
    let token = if local_settings {
        if !address.ip().is_loopback() {
            return Err(
                "The market monitor requires a loopback bind in local settings mode".into(),
            );
        }
        let token = std::env::var("PLAYGROUND_MARKET_SERVICE_TOKEN").unwrap_or_default();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("PLAYGROUND_MARKET_SERVICE_TOKEN must contain 64 hexadecimal characters in local settings mode".into());
        }
        Some(Arc::<str>::from(token))
    } else {
        None
    };
    let binance = Arc::new(binance::Binance::new());
    let notifier = Arc::new(notifications::Notifier::new(local_settings)?);
    let store = local_settings
        .then(store::Store::open_default)
        .transpose()?
        .map(Arc::new);
    // Order execution needs the local database and the token-protected routes.
    let trader = store.as_ref().map(|store| {
        let settings = trading::Settings::load(&store.trading_account_path());
        match &settings.problem {
            Some(problem) => eprintln!("下单未开启：{problem}"),
            None => eprintln!("下单模式：{:?}，单笔上限 {} USDT", settings.mode, settings.max_notional),
        }
        Arc::new(trading::Trader::new(
            settings,
            Arc::clone(store),
            Arc::clone(&binance),
        ))
    });
    let app = routes::router(binance.clone(), store.clone(), notifier.clone(), trader.clone(), token)?;
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let trading = trader.map(|trader| tokio::spawn(trading::supervise(trader, stopped.clone())));
    let worker = store.as_ref().map(|store| {
        tokio::spawn(monitor::supervise(
            Arc::clone(store),
            Arc::clone(&binance),
            Arc::clone(&notifier),
            stopped,
        ))
    });
    writeln!(
        std::io::stdout(),
        "PLAYGROUND_MARKET_SERVICE_ADDRESS={address}"
    )?;
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    let _ = stop.send(true);
    if let Some(worker) = worker {
        worker.await?;
    }
    if let Some(trading) = trading {
        trading.await?;
    }
    served?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
