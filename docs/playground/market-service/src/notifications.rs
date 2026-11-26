use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::Duration;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use chrono::{DateTime, FixedOffset};
use hmac::{Hmac, Mac};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::sync::Mutex;

use crate::now_ms;
use crate::strategy::MARKET_SPIKE_NAME;

#[derive(Default, Deserialize, Serialize)]
struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    webhook: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
    enabled: Option<bool>,
}

pub struct Message {
    title: String,
    lines: Vec<String>,
    id: Option<String>,
}

impl Message {
    fn text(&self) -> String {
        format!("{}\n{}", self.title, self.lines.join("\n"))
    }
}

#[derive(Default)]
struct Recent {
    attempts: VecDeque<i64>,
    ids: HashMap<String, i64>,
}

pub struct Notifier {
    client: Client,
    local: bool,
    path: PathBuf,
    write: Mutex<()>,
    recent: Mutex<Recent>,
}

impl Notifier {
    pub fn new(local: bool) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            local,
            path: PathBuf::from(".cache/strategy-notifications/dingtalk.json"),
            write: Mutex::new(()),
            recent: Mutex::new(Recent::default()),
        })
    }

    fn read(&self) -> crate::store::Result<Config> {
        let mut config = if self.local {
            self.read_saved()?
        } else {
            Config::default()
        };
        if config.webhook.is_none() {
            config.webhook = std::env::var("DINGTALK_WEBHOOK_URL").ok();
            config.secret = std::env::var("DINGTALK_WEBHOOK_SECRET").ok();
        }
        Ok(config)
    }

    fn read_saved(&self) -> crate::store::Result<Config> {
        match std::fs::read(&self.path) {
            Ok(bytes) => {
                let config: Config = serde_json::from_slice(&bytes)?;
                if config.enabled.is_none() {
                    return Err("invalid saved notification settings".into());
                }
                Ok(config)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(error) => Err(error.into()),
        }
    }

    fn target(&self) -> Result<(Url, Option<String>), &'static str> {
        let config = self.read().map_err(|_| "config-unavailable")?;
        let url = webhook(config.webhook.as_deref())?;
        if config.enabled == Some(false) {
            return Err("paused");
        }
        Ok((url, config.secret))
    }

    pub fn status(&self) -> &'static str {
        self.target().err().unwrap_or("ready")
    }

    pub async fn save(&self, change: &Value) -> &'static str {
        let _write = self.write.lock().await;
        let config = if let Some((url, secret)) = change["webhook"]
            .as_str()
            .zip(change["secret"].as_str())
            .filter(|(url, secret)| {
                url.encode_utf16().count() <= 2_048 && secret.encode_utf16().count() <= 256
            }) {
            Config {
                webhook: Some(url.trim().to_owned()),
                secret: Some(secret.trim().to_owned()),
                enabled: Some(true),
            }
        } else if let Some(enabled) = change["enabled"]
            .as_bool()
            .filter(|_| change.get("webhook").is_none())
        {
            let Ok(mut config) = self.read_saved() else {
                return "config-unavailable";
            };
            config.enabled = Some(enabled);
            config
        } else {
            return "invalid";
        };
        let env_webhook = std::env::var("DINGTALK_WEBHOOK_URL").ok();
        if let Err(reason) = webhook(config.webhook.as_deref().or(env_webhook.as_deref())) {
            return reason;
        }
        if crate::store::write_private_json(&self.path, &config).is_err() {
            return "config-unavailable";
        }
        if config.enabled == Some(false) {
            "paused"
        } else {
            "ready"
        }
    }

    pub async fn send(&self, message: Message) -> &'static str {
        let (mut url, secret) = match self.target() {
            Ok(target) => target,
            Err(status) => return status,
        };
        let now = now_ms();
        {
            let mut recent = self.recent.lock().await;
            let cutoff = now - 60_000;
            while recent
                .attempts
                .front()
                .is_some_and(|attempt| *attempt <= cutoff)
            {
                recent.attempts.pop_front();
            }
            recent.ids.retain(|_, last_attempt| *last_attempt > cutoff);
            if message
                .id
                .as_ref()
                .is_some_and(|id| recent.ids.contains_key(id))
            {
                return "duplicate";
            }
            if recent.attempts.len() >= 20 {
                return "rate-limited";
            }
            recent.attempts.push_back(now);
            if let Some(id) = &message.id {
                recent.ids.insert(id.clone(), now);
            }
        }
        if let Some(secret) = secret
            .as_deref()
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
        {
            let timestamp = now.to_string();
            let mut hmac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
                .expect("HMAC supports arbitrary key length");
            hmac.update(format!("{timestamp}\n{secret}").as_bytes());
            let signature = BASE64_STANDARD.encode(hmac.finalize().into_bytes());
            let retained: Vec<_> = url
                .query_pairs()
                .filter(|(name, _)| name != "timestamp" && name != "sign")
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect();
            url.query_pairs_mut()
                .clear()
                .extend_pairs(retained)
                .append_pair("timestamp", &timestamp)
                .append_pair("sign", &signature);
        }
        let content = message.text();
        if let Ok(response) = self
            .client
            .post(url)
            .json(&json!({"msgtype":"text","text":{"content":content}}))
            .send()
            .await
        {
            if response.status().is_success()
                && response
                    .json::<Value>()
                    .await
                    .is_ok_and(|body| body["errcode"].as_i64() == Some(0))
            {
                return "sent";
            }
        }
        if let Some(id) = &message.id {
            let mut recent = self.recent.lock().await;
            if recent.ids.get(id) == Some(&now) {
                recent.ids.remove(id);
            }
        }
        "failed"
    }
}

fn webhook(value: Option<&str>) -> Result<Url, &'static str> {
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("unconfigured")?;
    let url = Url::parse(raw).map_err(|_| "invalid")?;
    if url.scheme() != "https"
        || url.host_str() != Some("oapi.dingtalk.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != "/robot/send"
    {
        return Err("invalid");
    }
    let mut tokens = url.query_pairs().filter(|(name, _)| name == "access_token");
    if !tokens
        .next()
        .is_some_and(|(_, token)| !token.trim().is_empty())
        || tokens.next().is_some()
    {
        return Err("invalid");
    }
    Ok(url)
}

pub fn format_event(event: &Value) -> Option<Message> {
    match event["kind"].as_str()? {
        "test" => {
            let text = match event.get("text") {
                Some(text) => text.as_str()?,
                None => "",
            };
            if text.encode_utf16().count() > 500 {
                return None;
            }
            let text = if text.trim().is_empty() {
                "交易策略通知已连通。"
            } else {
                text.trim()
            };
            Some(Message {
                title: "钉钉推送测试".into(),
                lines: vec![text.into()],
                id: None,
            })
        }
        "market-spike" => {
            let symbol = event["symbol"]
                .as_str()
                .filter(|symbol| crate::routes::valid_symbol(symbol))?;
            let time = event["time"].as_i64().filter(|time| *time > 0)?;
            let level = event["level"].as_u64().filter(|level| *level > 0)?;
            let seconds = event["seconds"].as_u64().filter(|seconds| *seconds > 0)?;
            let previous = event["previous"].as_f64().filter(|price| *price > 0.0)?;
            let price = event["price"].as_f64().filter(|price| *price > 0.0)?;
            let threshold = event["threshold"]
                .as_f64()
                .filter(|threshold| *threshold != 0.0)?;
            let change = event["change"]
                .as_f64()
                .filter(|change| *change != 0.0 && change.signum() == threshold.signum())?;
            let date = DateTime::from_timestamp_millis(time)?
                .with_timezone(&FixedOffset::east_opt(28_800)?);
            let percent = |value| {
                format!(
                    "{}{}",
                    if value > 0.0 { "+" } else { "" },
                    decimal(value, 4)
                )
            };
            let observation = event["observationMinutes"]
                .as_u64()
                .filter(|minutes| *minutes > 0);
            let (window, reference_label) = match observation {
                Some(minutes) => (format!("观察期 {minutes} 分钟"), "本档参考价"),
                None => (format!("{seconds} 秒窗口"), "参考价"),
            };
            let mut lines = vec![
                format!("{}（北京时间）", date.format("%Y/%-m/%-d %H:%M:%S")),
                format!(
                    "{window} · 涨跌 {}% · 阈值 {}%",
                    percent(change),
                    percent(threshold)
                ),
                format!("{reference_label} {previous} → 触发价 {price} USDT"),
            ];
            if let Some(original) = event["originalReference"]
                .as_f64()
                .filter(|price| observation.is_some() && *price > 0.0)
            {
                lines.push(format!("原始参考价 {original} USDT"));
            }
            let multiple = event["volume"]["multiple"]
                .as_f64()
                .or(event["multiple"].as_f64());
            if let Some(multiple) = multiple.filter(|multiple| *multiple >= 0.0) {
                let mut label = format!("成交额{}倍", decimal(multiple, 2));
                if let Some((baseline, turnover)) = event["volume"]["baseline"]
                    .as_f64()
                    .zip(event["volume"]["turnover"].as_f64())
                    .filter(|(baseline, turnover)| *baseline > 0.0 && *turnover >= 0.0)
                {
                    label.push_str(&format!(
                        "({}万 -> {}万)",
                        decimal(baseline / 10_000.0, 2),
                        decimal(turnover / 10_000.0, 2)
                    ));
                }
                lines.push(label);
            }
            Some(Message {
                title: format!("【{MARKET_SPIKE_NAME}】{symbol} {level} 级告警"),
                lines,
                id: Some(format!(
                    "market-spike:{symbol}:{time}:{seconds}:{threshold}:{level}"
                )),
            })
        }
        _ => None,
    }
}

fn decimal(value: f64, precision: usize) -> String {
    let text = format!("{value:.precision$}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_strategy_name_for_alerts_and_a_plain_title_for_test_messages() {
        let event = json!({
            "kind": "market-spike", "symbol": "BTCUSDT", "time": 1_700_000_000_000_i64,
            "level": 2, "seconds": 30, "previous": 100, "price": 95, "change": -5, "threshold": -5,
            "volume": {"multiple": 3.25, "baseline": 120_000, "turnover": 390_000},
        });
        let expected = "【异动监控策略】BTCUSDT 2 级告警\n2023/11/15 06:13:20（北京时间）\n30 秒窗口 · 涨跌 -5% · 阈值 -5%\n参考价 100 → 触发价 95 USDT\n成交额3.25倍(12万 -> 39万)";
        assert_eq!(format_event(&event).unwrap().text(), expected);

        let mut saved_event = event;
        saved_event["forecastDirection"] = json!("up");
        assert_eq!(format_event(&saved_event).unwrap().text(), expected);

        saved_event["observationMinutes"] = json!(15);
        saved_event["previous"] = json!(95.0);
        saved_event["price"] = json!(90.25);
        saved_event["originalReference"] = json!(100.0);
        let upgrade = format_event(&saved_event).unwrap().text();
        assert!(upgrade.contains("观察期 15 分钟 · 涨跌 -5% · 阈值 -5%"));
        assert!(upgrade.contains("本档参考价 95 → 触发价 90.25 USDT"));
        assert!(upgrade.contains("原始参考价 100 USDT"));

        let test = format_event(&json!({"kind": "test"})).unwrap();
        assert_eq!(test.text(), "钉钉推送测试\n交易策略通知已连通。");
    }
}
