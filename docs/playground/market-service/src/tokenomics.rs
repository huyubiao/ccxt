use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use reqwest::Url;
use serde_json::{json, Value};

use crate::binance::number;
use crate::holders::save_snapshot;
use crate::markets::{Cache, Instrument, Markets, Snapshot};
use crate::now_ms;
use crate::research::{coin_symbol, positive, Research};

const DAY: i64 = 86_400_000;
const RETRY: i64 = 6 * 3_600_000;
const CACHE_VERSION: i64 = 4;
const CMC: &str = "https://api.coinmarketcap.com/data-api/v3";

pub struct Unlocks {
    markets: Arc<Markets>,
    issuance: Value,
    staking: Value,
    reviewed: Value,
    cache: Cache<String, Value>,
}

impl Unlocks {
    pub fn new(markets: Arc<Markets>) -> crate::store::Result<Self> {
        Ok(Self {
            markets,
            issuance: serde_json::from_str(include_str!("../../lib/coin-issuance-rules.json"))?,
            staking: serde_json::from_str(include_str!("../../lib/coin-staking-rules.json"))?,
            reviewed: serde_json::from_str(include_str!("../../scripts/reviewed-unlocks.json"))?,
            cache: Cache::new(),
        })
    }

    pub async fn read(
        &self,
        research: &Research,
        pair: &Instrument,
        seed: &Value,
        stored: &Value,
        preferred: Option<&str>,
        fallback: Option<&str>,
    ) -> (Value, Option<String>) {
        let start = now_ms();
        let contract = &pair.id;
        let base = self.tokenomics(contract, start, seed, stored);
        if base["kind"] == "mining" || base["kind"] == "staking" {
            return (base, text(&seed["geckoId"]));
        }
        let entry = self.cache.entry(contract.clone()).await;
        let mut cache = entry.lock().await;
        let file = Path::new(".cache/unlocks").join(format!("{}.json", safe_file_name(contract)));
        let mut saved = cache
            .as_ref()
            .map(|entry| entry.value.clone())
            .or_else(|| {
                std::fs::read(&file)
                    .ok()
                    .and_then(|file| serde_json::from_slice::<Value>(&file).ok())
            })
            .unwrap_or_default();
        let attempted = saved["attemptedAt"].as_i64().unwrap_or_default();
        let version = saved["version"].as_i64();
        let clean = matches!(version, Some(1..=CACHE_VERSION))
            && saved["attemptedAt"].is_number()
            && (saved["row"].is_null()
                || saved["row"]["symbol"].is_string()
                    && saved["row"]["events"].as_array().is_some_and(|events| {
                        events
                            .iter()
                            .all(|row| row["time"].is_number() && row["allocations"].is_array())
                    }));
        let seed_updated = seed["updatedAt"]
            .as_i64()
            .or_else(|| stored["generatedAt"].as_i64())
            .unwrap_or_default();
        if !clean
            || (!seed.is_null()
                && saved["row"]["updatedAt"].as_i64().unwrap_or(attempted) < seed_updated)
        {
            saved = Value::Null;
        }
        let prior = if saved["row"].is_object() {
            &saved["row"]
        } else {
            seed
        };
        let tokenomics = self.tokenomics(contract, start, prior, stored);
        let history_checked = if saved["row"].is_object() {
            saved["version"] == CACHE_VERSION
        } else {
            seed["recentUnlocks"].is_array()
        };
        if history_checked
            && complete(&tokenomics)
            && start - tokenomics["updatedAt"].as_i64().unwrap_or_default() < DAY
            || saved["version"] == CACHE_VERSION && start - attempted < RETRY
        {
            return (tokenomics, text(&prior["geckoId"]));
        }
        let id = preferred
            .or_else(|| prior["geckoId"].as_str())
            .or_else(|| seed["geckoId"].as_str())
            .or(fallback);
        let fresh = if let Some(id) = id.filter(|id| safe_asset(id)) {
            self.refresh(research, id, coin_symbol(pair), prior, start)
                .await
        } else {
            None
        };
        let row = fresh.or_else(|| saved.get("row").cloned().filter(Value::is_object));
        let mut snapshot = json!({"version":CACHE_VERSION,"attemptedAt":start});
        if let Some(row) = row.as_ref() {
            snapshot["row"] = row.clone();
        }
        let _ = save_snapshot(&file, &snapshot);
        *cache = Some(Snapshot {
            value: snapshot,
            until: start + RETRY,
        });
        let row = row.as_ref().unwrap_or(seed);
        (
            self.tokenomics(contract, start, row, stored),
            text(&row["geckoId"]),
        )
    }

    fn tokenomics(&self, contract: &str, now: i64, row: &Value, stored: &Value) -> Value {
        let rule = &self.issuance[contract];
        let staking = &self.staking[contract];
        let denominator = row["percentageSupply"].as_f64();
        let locked = row["lockedAmount"].as_f64().filter(|amount| {
            *amount >= 0.0
                && denominator.is_none_or(|base| base <= 0.0 || *amount <= base * (1.0 + 1e-7))
        });
        let mut events = if let Some(events) = row["events"].as_array() {
            events.clone()
        } else if row["time"].is_number() {
            vec![row.clone()]
        } else {
            Vec::new()
        };
        events.retain(|event| {
            event["time"].as_i64().is_some_and(|time| time > now)
                && (event["timeKind"] != "interval-estimate"
                    || event["periodStart"]
                        .as_i64()
                        .is_some_and(|time| time >= now))
        });
        events.sort_by_key(event_time);
        let with_percentage = |mut event: Value| {
            if event["timeKind"].is_null() {
                event["timeKind"] = json!("scheduled");
            }
            event["supplyPercentage"] = json!(event["amount"]
                .as_f64()
                .zip(denominator.filter(|supply| *supply > 0.0))
                .map(|(amount, supply)| amount / supply * 100.0));
            event
        };
        let upcoming: Vec<_> = events
            .iter()
            .take(3)
            .cloned()
            .map(with_percentage)
            .collect();
        let next_cliff = if upcoming.iter().any(|event| event["mechanism"] == "cliff") {
            None
        } else {
            events.iter().find(|event| event["mechanism"] == "cliff")
        };
        let anchor = &stored["blockHeights"][contract];
        let mining = if rule.is_object() {
            mining(rule, anchor)
        } else {
            None
        };
        let recent = if rule.is_object() || staking.is_object() {
            Vec::new()
        } else {
            recent_unlocks(
                stored_events(row).chain(stored_events(&stored["contracts"][contract])),
                now,
            )
            .into_iter()
            .map(with_percentage)
            .collect::<Vec<_>>()
        };
        let kind = if rule.is_object() {
            "mining"
        } else if staking.is_object() {
            "staking"
        } else if row["events"]
            .as_array()
            .is_some_and(|events| !events.is_empty())
            || row["time"].is_number()
            || !row["lockedAmount"].is_null()
            || !recent.is_empty()
        {
            "vesting"
        } else {
            "unknown"
        };
        let value = |field: &str| {
            rule.get(field)
                .or_else(|| staking.get(field))
                .or_else(|| row.get(field))
                .cloned()
                .unwrap_or_default()
        };
        let mut result = json!({"symbol":value("symbol").as_str().unwrap_or_else(||contract.strip_suffix("USDT").unwrap_or(contract)),
            "kind":kind,"lockedAmount":locked,"maxSupply":value("maxSupply"),"supplyLimit":match kind{"mining"=>"capped","staking"=>"unlimited",_=>row["supplyLimit"].as_str().unwrap_or("unknown")},
            "percentageSupply":denominator,"percentageBasis":row["percentageBasis"],"events":upcoming,"recentUnlocks":recent,"mining":mining,
            "staking":staking.is_object().then(||json!({"mechanism":"proof-of-stake","recipients":staking["recipients"],"hasFixedHalving":false,
                "hasFeeBurn":staking["hasFeeBurn"],"dailyIssuance":null,"dailyBurn":null,"dailyNetIssuance":null})),
            "sourceName":value("sourceName").as_str().unwrap_or_default(),"sourceUrl":value("sourceUrl").as_str().unwrap_or_default(),
            "updatedAt":anchor["time"].as_i64().filter(|_|rule.is_object()).or_else(||staking["reviewedAt"].as_i64()).or_else(||row["updatedAt"].as_i64()).or_else(||stored["generatedAt"].as_i64())});
        if let Some(next) = next_cliff {
            result["nextCliff"] = next.clone();
        }
        result
    }

    async fn refresh(
        &self,
        research: &Research,
        id: &str,
        base: &str,
        prior: &Value,
        now: i64,
    ) -> Option<Value> {
        let symbol = token_symbol(base);
        let (cmc, llama, tokenomist) = tokio::join!(
            self.cmc(research, id, base, &symbol, now),
            self.llama(research, id, &symbol),
            self.tokenomist(research, id, &symbol, now)
        );
        let reviewed = self
            .reviewed
            .get(id)
            .filter(|row| row["symbol"] == symbol)
            .cloned()
            .unwrap_or_default();
        let reviewed_events = reviewed["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|event| {
                let mut parsed = cliff(
                    event["sourceName"].as_str()?,
                    event["sourceUrl"].as_str()?,
                    &symbol,
                    date(&event["date"])?,
                    positive(&event["amount"])?,
                    event["allocations"]
                        .as_array()?
                        .iter()
                        .filter_map(|row| {
                            allocation(row["name"].as_str()?, positive(&row["amount"])?)
                        })
                        .collect(),
                )?;
                if let Some(note) = event.get("note") {
                    parsed["note"] = note.clone();
                }
                if let Some(checks) = event.get("sourceChecks") {
                    parsed["sourceChecks"] = checks.clone();
                }
                if let Some(mechanism) = event.get("mechanism") {
                    parsed["mechanism"] = mechanism.clone();
                }
                Some(parsed)
            });
        let cmc_events = cmc
            .as_ref()
            .and_then(|row| row["events"].as_array())
            .cloned()
            .unwrap_or_default();
        let candidates: Vec<_> = llama
            .clone()
            .unwrap_or_default()
            .into_iter()
            .chain(reviewed_events)
            .chain(tokenomist.clone().unwrap_or_default())
            .chain(cmc_events.clone())
            .collect();
        let recent = recent_unlocks(
            candidates.iter()
                .chain(cmc.iter().flat_map(stored_events))
                .chain(stored_events(prior)),
            now,
        );
        let has_history = candidates.iter().any(|event| completed(event, now));
        let events = merge(candidates, now);
        if cmc.is_none() && events.is_empty() && !has_history {
            return None;
        }
        let fresh_groups: HashSet<_> = events
            .iter()
            .map(|event| {
                (
                    event["sourceName"].as_str().unwrap_or_default().to_owned(),
                    group(event),
                )
            })
            .collect();
        let previous = prior["events"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let carried = previous
            .iter()
            .filter(|event| {
                let name = event["sourceName"].as_str().unwrap_or_default();
                let unavailable = match name {
                    "DefiLlama" => llama.is_none(),
                    "Tokenomist" => tokenomist.is_none(),
                    "CoinMarketCap" => cmc.as_ref().is_none_or(|row| {
                        cmc_events.is_empty() && row["lockedAmount"].as_f64() != Some(0.0)
                    }),
                    _ => false,
                };
                unavailable && !fresh_groups.contains(&(name.to_owned(), group(event)))
            })
            .cloned();
        let had_events = !events.is_empty();
        let releases: Vec<_> = merge(events.into_iter().chain(carried).collect(), now)
            .into_iter()
            .map(|mut event| {
                if event["allocationComplete"] != true {
                    if let Some(stored) = previous.iter().find(|prior| {
                        prior["allocationComplete"] == true
                            && ["sourceName", "time", "mechanism", "amount"]
                                .iter()
                                .all(|field| prior[*field] == event[*field])
                    }) {
                        event["allocationComplete"] = json!(true);
                        event["allocations"] = stored["allocations"].clone();
                    }
                }
                event
            })
            .collect();
        let cap = positive(&reviewed["maxSupply"]);
        let metadata = cmc.as_ref().unwrap_or(prior);
        let supply = if cap.is_some() {
            &reviewed
        } else if cmc
            .as_ref()
            .is_some_and(|row| !row["percentageSupply"].is_null())
        {
            cmc.as_ref().unwrap_or(prior)
        } else if prior.is_object() {
            prior
        } else if metadata.is_object() {
            metadata
        } else {
            releases.first().unwrap_or(&reviewed)
        };
        Some(
            json!({"symbol":symbol,"geckoId":id,"cmcSlug":metadata["cmcSlug"],"lockedAmount":cmc.as_ref().and_then(|row|row["lockedAmount"].as_f64()).or_else(||prior["lockedAmount"].as_f64()),
            "maxSupply":supply["maxSupply"],"supplyLimit":if cap.is_some(){"capped"}else{supply["supplyLimit"].as_str().unwrap_or("unknown")},
            "percentageSupply":cap.or_else(||supply["percentageSupply"].as_f64()),"percentageBasis":if cap.is_some(){json!("maxSupply")}else{supply["percentageBasis"].clone()},
            "events":releases,"recentUnlocks":recent,"sourceName":supply["sourceName"],"sourceUrl":supply["sourceUrl"],
            "updatedAt":if !releases.is_empty()&&!had_events{prior["updatedAt"].as_i64().unwrap_or(now)}else{now}}),
        )
    }

    async fn cmc(
        &self,
        research: &Research,
        id: &str,
        base: &str,
        symbol: &str,
        now: i64,
    ) -> Option<Value> {
        let slug = research.slug(id);
        let response = self
            .markets
            .http(CMC, "cryptocurrency/detail", &[("slug", slug)])
            .await
            .ok()?;
        let row = &response["data"];
        let advertised = row["symbol"].as_str()?;
        if row["slug"] != slug
            || response["status"]["error_code"] != 0 && response["status"]["error_code"] != "0"
            || (!advertised.eq_ignore_ascii_case(base) && !advertised.eq_ignore_ascii_case(symbol))
        {
            return None;
        }
        let stats = &row["statistics"];
        let max = positive(&stats["maxSupply"]);
        let total = positive(&stats["totalSupply"]);
        let supply = if row["isInfiniteMaxSupply"] == 1 {
            "unlimited"
        } else if max.is_some() {
            "capped"
        } else {
            "unknown"
        };
        let info = &row["tokenUnlockLatest"];
        let locked = info["tokenLockedAmount"]
            .as_f64()
            .filter(|amount| *amount >= 0.0);
        let source = format!("https://coinmarketcap.com/currencies/{slug}/#token-unlocks");
        let mut events = parse_scheduled(info, &advertised.to_uppercase(), &source, now);
        let has_future = !events.is_empty() || locked.is_some_and(|locked| locked > 0.0);
        let mut history = Vec::new();
        if has_future || locked.is_some() {
            if let Some(id) = row["id"].as_u64() {
                let id = id.to_string();
                let (month, year) = tokio::join!(
                    self.curve(&id, "1M", advertised, &source),
                    self.curve(&id, "1Y", advertised, &source)
                );
                let mut estimates: Vec<_> = month.into_iter().chain(year).collect();
                estimates.sort_by_key(event_time);
                for event in estimates {
                    if event_time(&event) <= now {
                        history.push(event);
                        continue;
                    }
                    if !has_future {
                        break;
                    }
                    let cutoff = events.last().map(event_time).unwrap_or(now);
                    if event["periodStart"].as_i64().unwrap_or_default() < cutoff {
                        continue;
                    }
                    events.push(event);
                    if events.len() >= 3 {
                        break;
                    }
                }
            }
        }
        Some(
            json!({"symbol":advertised,"geckoId":id,"cmcSlug":slug,"updatedAt":now,"lockedAmount":locked,"maxSupply":max,
            "supplyLimit":supply,"percentageSupply":max.or(total),"percentageBasis":max.map(|_|"maxSupply").or(total.map(|_|"totalSupply")),
            "events":events,"recentUnlocks":history,"sourceUrl":source,"sourceName":"CoinMarketCap"}),
        )
    }

    async fn curve(
        &self,
        id: &str,
        range: &str,
        symbol: &str,
        source: &str,
    ) -> Vec<Value> {
        let result = self
            .markets
            .http(
                CMC,
                "token-unlock/historical",
                &[("cryptoId", id), ("range", range)],
            )
            .await
            .unwrap_or_default();
        if result["status"]["error_code"] != 0 && result["status"]["error_code"] != "0" {
            return Vec::new();
        }
        let mut points = BTreeMap::<i64, BTreeMap<String, (f64, Value)>>::new();
        for row in result["data"]["tokenHistory"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(((time, amount), name)) = date(&row["time"])
                .zip(number(&row["amount"]).filter(|amount| *amount >= 0.0))
                .zip(
                    row["allocationName"]
                        .as_str()
                        .filter(|name| !name.is_empty()),
                )
            {
                points
                    .entry(time)
                    .or_default()
                    .insert(name.into(), (amount, row["version"].clone()));
            }
        }
        let points: Vec<_> = points.into_iter().collect();
        points.windows(2).filter_map(|pair|{
            let [(start,previous),(time,current)]=pair else{return None;};
            if current.len()!=previous.len(){return None;}
            let mut allocations=Vec::new();let mut total=0.0;
            for (name,(amount,version)) in current{
                let (old,prior_version)=previous.get(name)?;
                if *version!=*prior_version||amount<old{return None;}
                let amount=amount-old;if amount>1e-6{allocations.push(allocation(name,amount)?);total+=amount;}
            }
            (!allocations.is_empty()).then(||json!({"symbol":symbol,"time":time,"periodStart":start,"timeKind":"interval-estimate",
                "amount":total,"allocations":allocations,"allocationComplete":true,"mechanism":null,"sourceName":"CoinMarketCap","sourceUrl":source}))
        }).collect()
    }

    async fn llama(&self, research: &Research, id: &str, symbol: &str) -> Option<Vec<Value>> {
        let key = std::env::var("DEFILLAMA_API_KEY")
            .ok()
            .filter(|key| !key.is_empty())?;
        let mut url = Url::parse("https://pro-api.llama.fi").ok()?;
        url.path_segments_mut()
            .ok()?
            .extend([key.as_str(), "api", "emission", id]);
        let response = research.public_json(url, None).await.ok()?;
        let body = &response["body"];
        if body["gecko_id"] != id {
            return None;
        }
        let source = format!("https://defillama.com/unlocks/{id}");
        Some(
            body["metadata"]["unlockEvents"]
                .as_array()?
                .iter()
                .filter_map(|row| {
                    cliff(
                        "DefiLlama",
                        &source,
                        symbol,
                        row["timestamp"].as_i64()?.checked_mul(1000)?,
                        positive(&row["summary"]["totalTokensCliff"])?,
                        row["cliffAllocations"]
                            .as_array()?
                            .iter()
                            .filter_map(|item| {
                                allocation(item["recipient"].as_str()?, positive(&item["amount"])?)
                            })
                            .collect(),
                    )
                })
                .collect(),
        )
    }

    async fn tokenomist(
        &self,
        research: &Research,
        id: &str,
        symbol: &str,
        now: i64,
    ) -> Option<Vec<Value>> {
        let key = std::env::var("TOKENOMIST_API_KEY")
            .ok()
            .filter(|key| !key.is_empty())?;
        let start = DateTime::<Utc>::from_timestamp_millis(now)?
            .format("%Y-%m-%d")
            .to_string();
        let mut url = Url::parse("https://api.unlocks.app/v4/unlock/events").ok()?;
        url.query_pairs_mut()
            .append_pair("tokenId", id)
            .append_pair("start", &start);
        let response = research
            .public_json(url, Some(("x-api-key", &key)))
            .await
            .ok()?;
        let rows = response["data"].as_array()?;
        if response["status"] != true
            || rows.iter().any(|row| {
                !row["tokenSymbol"]
                    .as_str()
                    .is_some_and(|reported| reported.eq_ignore_ascii_case(symbol))
            })
        {
            return None;
        }
        let source = format!("https://tokenomist.ai/{id}");
        Some(
            rows.iter()
                .filter_map(|row| {
                    let cliff_row = &row["cliffUnlocks"];
                    let details = cliff_row["allocationBreakdown"].as_array()?;
                    if details.is_empty()
                        || details.iter().any(|item| {
                            !matches!(
                                item["unlockPrecision"].as_str(),
                                Some("second" | "minute" | "hour" | "day")
                            )
                        })
                    {
                        return None;
                    }
                    cliff(
                        "Tokenomist",
                        &source,
                        symbol,
                        date(&row["unlockDate"])?,
                        positive(&cliff_row["cliffAmount"])?,
                        details
                            .iter()
                            .filter_map(|item| {
                                allocation(
                                    item["allocationName"].as_str()?,
                                    positive(&item["cliffAmount"])?,
                                )
                            })
                            .collect(),
                    )
                })
                .collect(),
        )
    }
}

fn parse_scheduled(row: &Value, symbol: &str, source: &str, now: i64) -> Vec<Value> {
    let Some((time, amount)) = positive(&row["nextUnlocked"]["date"])
        .filter(|time| *time > now as f64 && *time <= 8.64e15)
        .zip(positive(&row["nextUnlocked"]["tokenAmount"]))
    else {
        return Vec::new();
    };
    let details = row["nextUnlockedDetail"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut allocations=details.iter().filter_map(|detail|{
        let name=detail["allocationName"].as_str()?.trim();
        (!name.is_empty()).then(||json!({"name":name,"amount":positive(&detail["tokenAmount"]),"group":allocation_group(name)}))
    }).collect::<Vec<_>>();
    let total: f64 = allocations
        .iter()
        .filter_map(|row| row["amount"].as_f64())
        .sum();
    let tolerance = (amount * 1e-7).max(1e-7);
    let known = !allocations.is_empty() && allocations.iter().all(|row| !row["amount"].is_null());
    let complete = known && (amount - total).abs() <= tolerance;
    if total > amount + tolerance {
        allocations.clear();
    } else if known && amount - total > tolerance {
        allocations.push(json!({"name":"分配用途未披露","amount":amount-total,"group":"other"}));
    }
    let kinds: Vec<_> = details
        .iter()
        .map(|row| {
            row["vestingType"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_lowercase()
        })
        .collect();
    let kind_set: HashSet<_> = kinds.iter().map(String::as_str).collect();
    let event = |amount, mechanism: Option<&str>, allocations: Vec<Value>| {
        json!({"symbol":symbol,"time":time as i64,"amount":amount,
        "timeKind":"scheduled","mechanism":mechanism,"allocationComplete":complete,"allocations":allocations,"sourceUrl":source,"sourceName":"CoinMarketCap"})
    };
    if complete
        && allocations.len() == details.len()
        && kind_set.len() == 2
        && kind_set.contains("cliff")
        && kind_set.contains("linear")
    {
        return ["cliff", "linear"]
            .map(|kind| {
                let matches: Vec<_> = allocations
                    .iter()
                    .zip(&kinds)
                    .filter(|(_, value)| *value == kind)
                    .map(|(row, _)| row.clone())
                    .collect();
                event(
                    matches
                        .iter()
                        .filter_map(|row| row["amount"].as_f64())
                        .sum(),
                    Some(kind),
                    matches,
                )
            })
            .to_vec();
    }
    let kind = kind_set.into_iter().next().filter(|kind| {
        kinds.iter().all(|item| item == kind) && matches!(*kind, "cliff" | "linear")
    });
    vec![event(amount, kind, allocations)]
}

fn stored_events(row: &Value) -> impl Iterator<Item = &Value> {
    row["events"]
        .as_array()
        .into_iter()
        .flatten()
        .chain((row["events"].is_null() && row["time"].is_number()).then_some(row))
        .chain(row["recentUnlocks"].as_array().into_iter().flatten())
}

fn completed(event: &Value, now: i64) -> bool {
    let time = event_time(event);
    time > 0
        && time <= now
        && positive(&event["amount"]).is_some()
        && (event["timeKind"] != "interval-estimate"
            || event["periodStart"]
                .as_i64()
                .is_some_and(|start| start < time))
}

fn recent_unlocks<'a>(events: impl Iterator<Item = &'a Value>, now: i64) -> Vec<Value> {
    let candidates = events.filter(|event| completed(event, now)).cloned();
    let mut recent = merge_releases(candidates, true);
    recent.sort_by_key(|event| Reverse(event_time(event)));
    recent.truncate(2);
    recent
}

fn merge(events: Vec<Value>, now: i64) -> Vec<Value> {
    let upcoming = events.into_iter().filter(|event| {
        event_time(event) > now
            && (event["timeKind"] != "interval-estimate"
                || event["periodStart"]
                    .as_i64()
                    .is_some_and(|start| start >= now))
    });
    merge_releases(upcoming, false)
}

fn merge_releases(events: impl Iterator<Item = Value>, historical: bool) -> Vec<Value> {
    let mut groups = HashMap::<(i64, String), Vec<Value>>::new();
    let mut estimates = Vec::new();
    for event in events {
        let Some(amount) = positive(&event["amount"]) else {
            continue;
        };
        if event["timeKind"] == "interval-estimate" {
            estimates.push(event);
            continue;
        }
        let group = groups.entry(group(&event)).or_default();
        let duplicate = group.iter_mut().find(|prior| {
            ["sourceName", "time"]
                .iter()
                .all(|field| prior[*field] == event[*field])
                && if historical {
                    positive(&prior["amount"]) == Some(amount)
                } else {
                    prior["amount"] == event["amount"] && prior["allocations"] == event["allocations"]
                }
        });
        if let Some(prior) = duplicate {
            if historical && prior["allocationComplete"] != true && event["allocationComplete"] == true {
                *prior = event;
            }
        } else {
            group.push(event);
        }
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by(|left, right| left.0.cmp(&right.0));
    let mut results = Vec::new();
    for (_, group) in groups {
        let names = group
            .iter()
            .filter_map(|row| row["sourceName"].as_str())
            .collect::<HashSet<_>>();
        if names.len() < group.len() {
            let preferred = group[0]["sourceName"].clone();
            results.extend(
                group
                    .into_iter()
                    .filter(|row| row["sourceName"] == preferred),
            );
            continue;
        }
        let votes: Vec<_> = group
            .iter()
            .map(|event| group.iter().filter(|other| agrees(event, other)).count())
            .collect();
        let best = votes.iter().copied().max().unwrap_or_default();
        let preferred = votes
            .iter()
            .position(|vote| *vote == best)
            .unwrap_or_default();
        let winner = group
            .iter()
            .enumerate()
            .position(|(index, event)| {
                votes[index] == best
                    && event["allocationComplete"] == true
                    && agrees(event, &group[preferred])
            })
            .unwrap_or(preferred);
        let mut event = group[winner].clone();
        if group.len() > 1 {
            let mut checks = event["sourceChecks"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for (index, other) in group.iter().enumerate() {
                if index != winner {
                    if historical {
                        checks.retain(|check| check["sourceName"] != other["sourceName"]);
                    }
                    checks.push(json!({"sourceName":other["sourceName"],"sourceUrl":other["sourceUrl"],
                        "amount":other["amount"],"agrees":agrees(&event,other)}));
                }
            }
            event["sourceChecks"] = json!(checks);
        }
        results.push(event);
    }
    if historical {
        estimates.sort_by_key(|event| {
            (Reverse(event_time(event)), Reverse(event["periodStart"].as_i64()))
        });
    } else {
        estimates.sort_by_key(event_time);
    }
    for estimate in estimates {
        let start = estimate["periodStart"].as_i64().unwrap_or_default();
        if !results.iter().any(|event| {
            event_time(event) > start
                && event["periodStart"]
                    .as_i64()
                    .unwrap_or_else(|| event_time(event))
                    <= event_time(&estimate)
        }) {
            results.push(estimate);
        }
    }
    results.sort_by_key(event_time);
    results
}

fn cliff(
    provider: &str,
    source: &str,
    symbol: &str,
    time: i64,
    amount: f64,
    allocations: Vec<Value>,
) -> Option<Value> {
    if time > 8_640_000_000_000_000 || amount <= 0.0 {
        return None;
    }
    let subtotal: f64 = allocations
        .iter()
        .filter_map(|row| row["amount"].as_f64())
        .sum();
    let tolerance = amount * 1e-7;
    let complete = !allocations.is_empty() && (subtotal - amount).abs() <= tolerance;
    Some(
        json!({"sourceName":provider,"sourceUrl":source,"symbol":symbol,"time":time,"amount":amount,"timeKind":"scheduled","mechanism":"cliff",
        "allocations":if subtotal<=amount+tolerance{allocations}else{Vec::new()},"allocationComplete":complete}),
    )
}

fn allocation(name: &str, amount: f64) -> Option<Value> {
    (!name.trim().is_empty() && amount.is_finite() && amount > 0.0)
        .then(|| json!({"name":name,"amount":amount,"group":allocation_group(name)}))
}
fn allocation_group(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let words: Vec<_> = lower
        .split(|letter: char| !letter.is_ascii_alphanumeric() && letter != '_')
        .filter(|word| !word.is_empty())
        .collect();
    if words.iter().any(|word| {
        matches!(
            *word,
            "foundation" | "treasury" | "dao" | "ecosystem" | "liquidity" | "staking" | "reserve"
        )
    }) || words.windows(2).any(|pair| pair == ["market", "maker"])
    {
        "other"
    } else if words.iter().any(|word| {
        matches!(
            *word,
            "team"
                | "founder"
                | "founders"
                | "advisor"
                | "advisors"
                | "adviser"
                | "advisers"
                | "investor"
                | "investors"
                | "contributor"
                | "contributors"
                | "employee"
                | "employees"
        )
    }) || words
        .windows(2)
        .any(|pair| matches!(pair, ["private" | "seed", "sale" | "round"]))
    {
        "insiders"
    } else if words
        .iter()
        .any(|word| matches!(*word, "user" | "users" | "airdrop"))
        || words.windows(2).any(|pair| {
            matches!(
                pair,
                ["public" | "community", "sale"] | ["individual", "wallets"]
            )
        })
    {
        "users"
    } else {
        "other"
    }
}
fn event_time(event: &Value) -> i64 {
    event["time"].as_i64().unwrap_or_default()
}
fn group(event: &Value) -> (i64, String) {
    (
        event_time(event).div_euclid(DAY),
        event["mechanism"].as_str().unwrap_or("unknown").into(),
    )
}
fn agrees(first: &Value, second: &Value) -> bool {
    let a = first["amount"].as_f64().unwrap_or_default();
    let b = second["amount"].as_f64().unwrap_or_default();
    (a - b).abs() <= a.max(b) * 0.01
}
pub fn date(value: &Value) -> Option<i64> {
    let value = value.as_str()?;
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
        .or_else(|| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|date| date.and_utc().timestamp_millis())
        })
}
fn safe_asset(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
fn safe_file_name(contract: &str) -> String {
    let mut escaped = String::new();
    for byte in contract.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            escaped.push(char::from(byte));
        } else {
            escaped.push_str(&format!("%{byte:02X}"));
        }
    }
    escaped
}
fn token_symbol(symbol: &str) -> String {
    let upper = symbol.to_uppercase();
    for prefix in ["1000000", "100000", "10000", "1000"] {
        if let Some(rest) = upper
            .strip_prefix(prefix)
            .filter(|rest| rest.as_bytes().first().is_some_and(u8::is_ascii_uppercase))
        {
            return rest.to_owned();
        }
    }
    upper
}
fn complete(data: &Value) -> bool {
    if data["lockedAmount"].is_null() || data["supplyLimit"] == "unknown" {
        return false;
    }
    let events = data["events"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    data["lockedAmount"].as_f64() == Some(0.0) && events.is_empty() && data["nextCliff"].is_null()
        || !data["percentageSupply"].is_null()
            && events.len() == 3
            && events
                .iter()
                .all(|event| event["allocationComplete"] == true)
            && (data["nextCliff"].is_null() || data["nextCliff"]["allocationComplete"] == true)
}
fn mining(rule: &Value, anchor: &Value) -> Option<Value> {
    let interval = rule["halvingInterval"]
        .as_i64()
        .filter(|value| *value > 0)?;
    let block_seconds = rule["targetBlockSeconds"]
        .as_i64()
        .filter(|value| *value > 0)?;
    let height = anchor["height"].as_i64()?;
    let epoch = height.div_euclid(interval);
    let initial = positive(&rule["initialBlockReward"])?;
    let reward = |epoch: i64| {
        if epoch >= 64 {
            0.0
        } else {
            (initial * 1e8 / 2.0_f64.powi(epoch as i32)).floor() / 1e8
        }
    };
    let next_height = (epoch + 1) * interval;
    Some(
        json!({"blockHeight":height,"heightSourceUrl":anchor["sourceUrl"],"blockReward":reward(epoch),
        "estimatedDailyIssuance":reward(epoch)*86400.0/block_seconds as f64,"nextHalvingHeight":next_height,
        "estimatedHalvingTime":anchor["time"].as_i64()?+(next_height-height)*block_seconds*1_000,"nextBlockReward":reward(epoch+1),
        "nextEstimatedDailyIssuance":reward(epoch+1)*86400.0/block_seconds as f64}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binance::Binance;

    #[test]
    fn exposes_two_completed_releases_with_allocations_and_keeps_future_releases() {
        let now = 10 * DAY;
        let release = |time| {
            cliff(
                "Source",
                "url",
                "TOKEN",
                time,
                25.0,
                vec![allocation("Investors", 25.0).unwrap()],
            )
            .unwrap()
        };
        let mut overlapping = release(now + DAY);
        overlapping["timeKind"] = json!("interval-estimate");
        overlapping["periodStart"] = json!(now - DAY);
        let mut archived = release(now);
        archived["amount"] = json!(25);
        let row = json!({"symbol":"TOKEN","percentageSupply":100.0,
            "events":[release(now - 3 * DAY), release(now + 2 * DAY), release(now), overlapping],
            "recentUnlocks":[archived]});
        let stored = json!({"contracts":{"TOKENUSDT":release(now - DAY)}});
        let unlocks = Unlocks::new(Arc::new(Markets::new(Arc::new(Binance::new())).unwrap())).unwrap();
        let result = unlocks.tokenomics("TOKENUSDT", now, &row, &stored);
        let past = result["recentUnlocks"].as_array().unwrap();
        assert_eq!(
            past.iter().map(event_time).collect::<Vec<_>>(),
            [now, now - DAY]
        );
        assert_eq!(past[0]["supplyPercentage"], 25.0);
        assert_eq!(past[0]["allocations"][0]["name"], "Investors");
        assert_eq!(result["events"].as_array().unwrap().len(), 1);
        assert_eq!(event_time(&result["events"][0]), now + 2 * DAY);
    }

    #[test]
    fn keeps_independent_release_types_and_records_source_disagreement() {
        let time = 9 * DAY;
        let disputed = cliff("Source A", "a", "TOKEN", time, 100.0, Vec::new()).unwrap();
        let agreed = cliff(
            "Source B",
            "b",
            "TOKEN",
            time,
            80.0,
            vec![allocation("Investors", 80.0).unwrap()],
        )
        .unwrap();
        let another = cliff("Source C", "c", "TOKEN", time, 80.0, Vec::new()).unwrap();
        let mut linear = agreed.clone();
        linear["mechanism"] = json!("linear");
        let merged = merge(vec![disputed, agreed, another, linear], time - DAY);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["amount"], json!(80.0));
        assert_eq!(merged[0]["sourceName"], "Source B");
        assert_eq!(merged[0]["sourceChecks"][0]["agrees"], false);
        assert_eq!(merged[1]["mechanism"], "linear");
    }

    #[test]
    fn splits_an_exact_mixed_schedule_by_mechanism() {
        let information = json!({"nextUnlocked":{"date":9000,"tokenAmount":110},"nextUnlockedDetail":[
            {"allocationName":"Seed round","tokenAmount":100,"vestingType":"cliff"},
            {"allocationName":"Airdrop","tokenAmount":10,"vestingType":"linear"}
        ]});
        let releases = parse_scheduled(&information, "TOKEN", "url", 1000);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0]["amount"], json!(100.0));
        assert_eq!(releases[0]["allocations"][0]["group"], "insiders");
        assert_eq!(releases[1]["amount"], json!(10.0));
    }
}
