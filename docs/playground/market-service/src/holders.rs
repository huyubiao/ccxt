use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use num_bigint::BigUint;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::binance::number;
use crate::markets::{Cache, Instrument, MarketError, Markets, Snapshot};
use crate::now_ms;
use crate::research::{positive, Research};

const LIMIT: usize = 200;
const FREE_BSC_LIMIT: usize = 100;
const VERSION: i64 = 4;
const CACHE_MS: i64 = 6 * 3_600_000;

struct Holder {
    address: String,
    balance: BigUint,
    label: Option<String>,
}

pub struct Holders {
    research: Arc<Research>,
    markets: Arc<Markets>,
    cache: Cache<String, Value>,
}

impl Holders {
    pub fn new(markets: Arc<Markets>, research: Arc<Research>) -> Self {
        Self {
            research,
            markets,
            cache: Cache::new(),
        }
    }

    pub async fn response(&self, pair: &Instrument) -> Value {
        let (snapshot, overview) = tokio::join!(self.snapshot(pair), self.research.overview(pair));
        let overview = overview.unwrap_or_default();
        let valuation = if overview["market"].is_object() {
            &overview["market"]
        } else {
            &overview["tokenomics"]
        };
        with_valuation(snapshot, valuation)
    }

    async fn snapshot(&self, pair: &Instrument) -> Value {
        let entry = self.cache.entry(pair.id.clone()).await;
        let mut cache = entry.lock().await;
        let now = now_ms();
        if let Some(saved) = cache.as_ref().filter(|saved| saved.until > now) {
            return saved.value.clone();
        }
        let folder = Path::new(".cache/holders");
        let file = folder.join(format!("{}.json", pair.id));
        let saved = cache
            .as_ref()
            .map(|saved| saved.value.clone())
            .or_else(|| serde_json::from_slice::<Value>(&std::fs::read(&file).ok()?).ok());
        if let Some(data) = saved.as_ref().filter(|data| {
            data["resolutionVersion"] == VERSION
                && cacheable(data)
                && data["fetchedAt"]
                    .as_i64()
                    .is_some_and(|at| now - at < CACHE_MS)
        }) {
            *cache = Some(Snapshot {
                value: data.clone(),
                until: data["fetchedAt"].as_i64().unwrap_or(now) + CACHE_MS,
            });
            return data.clone();
        }
        let data = match self.fetch(pair).await {
            Ok(mut data) => {
                data["resolutionVersion"] = json!(VERSION);
                data
            }
            Err(_) => {
                if let Some(mut data) = saved.filter(has_rows) {
                    data["stale"] = json!(true);
                    data["message"] = json!("刷新失败，显示上次快照。");
                    data
                } else {
                    empty(
                        pair,
                        "unavailable",
                        "暂时无法取得持币地址资料，稍后可重新打开查看。",
                    )
                }
            }
        };
        let durable = data["stale"] != true && cacheable(&data);
        if durable {
            let _ = save_snapshot(&file, &data);
        }
        *cache = Some(Snapshot {
            value: data.clone(),
            until: now_ms() + if durable { CACHE_MS } else { 60_000 },
        });
        data
    }

    async fn fetch(&self, pair: &Instrument) -> Result<Value, MarketError> {
        let Some(id) = self.research.identity(pair).await? else {
            return Ok(empty(pair, "unsupported", "尚未核实该币种的链上身份。"));
        };
        match id.as_str() {
            "bitcoin" | "ripple" | "tron" => return self.native(pair, &id).await,
            "ethereum" => return self.blockscout(pair, 1, None).await,
            "solana" | "sui" | "binancecoin" | "dogecoin" | "litecoin" | "bitcoin-cash"
            | "avalanche-2" | "cardano" | "polkadot" | "cosmos" | "aptos" | "the-open-network"
            | "toncoin" | "near" | "initia" | "celestia" | "injective" | "theta-token" => {
                return Ok(empty(
                    pair,
                    "unsupported",
                    "该原生币所在链尚无已接入的地址排名来源。",
                ))
            }
            _ => {}
        }
        let cmc = self.research.cmc_details(&id, &pair.coin).await;
        let mut failed = cmc.is_err();
        let cmc = cmc.ok().flatten();
        let cmc_platforms: Vec<_> = cmc
            .as_ref()
            .into_iter()
            .flat_map(|row| row["platforms"].as_array().into_iter().flatten())
            .filter_map(|row| {
                Some((
                    row["contractChainId"].as_u64()?,
                    row["contractAddress"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let mut gecko = if cmc_platforms
            .iter()
            .map(|(chain, _)| *chain)
            .collect::<HashSet<_>>()
            .len()
            > 1
        {
            Some(self.research.platforms(&id, &pair.coin).await)
        } else {
            None
        };
        let mut tried = HashSet::new();
        if cmc.is_some() {
            let primary = gecko
                .as_ref()
                .and_then(|result| result.as_ref().ok())
                .and_then(Option::as_ref)
                .and_then(|row| {
                    let chain = row["asset_platform_id"].as_str()?;
                    Some((
                        chain_id(chain)?,
                        row["platforms"][chain].as_str()?.to_owned(),
                    ))
                });
            let platforms = primary.into_iter().chain(cmc_platforms).collect();
            if let Some(data) = self
                .try_platforms(pair, &id, platforms, &mut tried, &mut failed)
                .await
            {
                return Ok(data);
            }
        }
        let gecko = match gecko.take() {
            Some(result) => result,
            None => self.research.platforms(&id, &pair.coin).await,
        };
        failed |= gecko.is_err();
        let gecko = gecko.ok().flatten();
        if let Some(row) = gecko.as_ref() {
            let primary = row["asset_platform_id"].as_str().and_then(chain_id);
            let mut platforms: Vec<_> = row["platforms"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(chain, address)| {
                    Some((chain_id(chain)?, address.as_str()?.to_owned()))
                })
                .collect();
            platforms.sort_by_key(|(chain, _)| primary != Some(*chain));
            if let Some(data) = self
                .try_platforms(pair, &id, platforms, &mut tried, &mut failed)
                .await
            {
                return Ok(data);
            }
        }
        if failed {
            return Err(MarketError::Unavailable);
        }
        Ok(empty(
            pair,
            "unsupported",
            if cmc.is_some() || gecko.is_some() {
                "该币种尚无可用的已核实链上地址排名。"
            } else {
                "尚未核实该币种的链上身份。"
            },
        ))
    }

    async fn try_platforms(
        &self,
        pair: &Instrument,
        id: &str,
        mut platforms: Vec<(u64, String)>,
        tried: &mut HashSet<(u64, String)>,
        failed: &mut bool,
    ) -> Option<Value> {
        if id == "arbitrum" {
            platforms.sort_by_key(|(chain, _)| *chain != 42161);
        }
        for (chain, address) in platforms {
            if (chain != 56 && explorer(chain).is_none())
                || !evm(&address)
                || !tried.insert((chain, address.to_lowercase()))
            {
                continue;
            }
            let result = if chain == 56 {
                self.bsc(pair, &address).await
            } else {
                self.blockscout(pair, chain, Some(&address)).await
            };
            match result {
                Ok(data) if has_rows(&data) => return Some(data),
                Err(_) => *failed = true,
                _ => {}
            }
        }
        None
    }

    async fn blockscout(
        &self,
        pair: &Instrument,
        chain: u64,
        address: Option<&str>,
    ) -> Result<Value, MarketError> {
        let (name, base) = explorer(chain).ok_or(MarketError::Unavailable)?;
        let (resource, source, decimals) = if let Some(address) = address {
            let token = format!("api/v2/tokens/{address}");
            let metadata = self.markets.http(base, &token, &[]).await?;
            if metadata["type"] != "ERC-20" {
                return Ok(empty(
                    pair,
                    "unsupported",
                    "该资产不是可核实数量的 ERC-20 代币。",
                ));
            }
            (
                format!("{token}/holders"),
                format!("{base}/token/{address}"),
                decimals(&metadata["decimals"]).ok_or(MarketError::Unavailable)?,
            )
        } else {
            ("api/v2/addresses".into(), format!("{base}/accounts"), 18)
        };
        let mut rows = Vec::new();
        let mut addresses = HashSet::new();
        let mut cursors = HashSet::new();
        let mut cursor = Vec::<(String, String)>::new();
        let mut exhausted = false;
        for _ in 0..10 {
            let query: Vec<_> = cursor
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect();
            let page = self.markets.http(base, &resource, &query).await;
            let items = page.as_ref().ok().and_then(|page| page["items"].as_array());
            let Some(items) = items else {
                if rows.is_empty() {
                    return Err(MarketError::Unavailable);
                }
                break;
            };
            for item in items {
                let account = if address.is_none() {
                    item
                } else {
                    &item["address"]
                };
                let balance = if address.is_none() {
                    &item["coin_balance"]
                } else {
                    &item["value"]
                };
                let holder = account["hash"]
                    .as_str()
                    .filter(|address| evm(address))
                    .ok_or(MarketError::Unavailable)?;
                let balance = balance
                    .as_str()
                    .and_then(raw_digits)
                    .ok_or(MarketError::Unavailable)?;
                if !addresses.insert(holder.to_lowercase()) {
                    continue;
                }
                let label = account["metadata"]["tags"]
                    .as_array()
                    .and_then(|tags| tags.iter().find(|tag| tag["tagType"] == "name"))
                    .and_then(|tag| tag["name"].as_str())
                    .or_else(|| account["name"].as_str())
                    .map(str::to_owned);
                rows.push(Holder {
                    address: holder.into(),
                    balance,
                    label,
                });
                if rows.len() == LIMIT {
                    break;
                }
            }
            let Some(next) = page
                .as_ref()
                .ok()
                .and_then(|page| page["next_page_params"].as_object())
            else {
                exhausted = true;
                break;
            };
            cursor = next
                .iter()
                .filter_map(|(key, value)| {
                    if let Some(value) = value.as_str() {
                        Some((key.clone(), value.into()))
                    } else if value.is_number() {
                        Some((key.clone(), value.to_string()))
                    } else {
                        None
                    }
                })
                .collect();
            if rows.len() == LIMIT || !cursors.insert(cursor.clone()) {
                break;
            }
        }
        let status = if exhausted || rows.len() == LIMIT {
            "available"
        } else {
            "partial"
        };
        let message = if status == "partial" {
            Some(format!(
                "本次仅取得 {} 个地址，未取得完整前 200 名。",
                rows.len()
            ))
        } else if rows.is_empty() {
            Some("来源当前未返回持币地址。".into())
        } else {
            None
        };
        Ok(snapshot(
            pair,
            status,
            message,
            HolderSource {
                chain: name,
                token: address,
                provider: "Blockscout",
                url: &source,
                decimals,
            },
            rows,
            |holder| format!("{base}/address/{holder}"),
        ))
    }

    async fn bsc(&self, pair: &Instrument, address: &str) -> Result<Value, MarketError> {
        let token = address.to_lowercase();
        let key = bsc_key();
        let limit = if key == "freekey" {
            FREE_BSC_LIMIT
        } else {
            LIMIT
        };
        let token_path = format!("getTokenInfo/{token}");
        let ranking_path = format!("getTopTokenHolders/{token}");
        let token_params = [("apiKey", key.as_str())];
        let limit_parameter = limit.to_string();
        let ranking_params = [
            ("apiKey", key.as_str()),
            ("limit", limit_parameter.as_str()),
        ];
        let (metadata, ranking) = tokio::try_join!(
            self.markets
                .http("https://api.binplorer.com", &token_path, &token_params),
            self.markets
                .http("https://api.binplorer.com", &ranking_path, &ranking_params)
        )?;
        if !metadata["address"]
            .as_str()
            .is_some_and(|address| address.eq_ignore_ascii_case(&token))
            || !metadata["symbol"]
                .as_str()
                .is_some_and(|symbol| symbol.eq_ignore_ascii_case(&pair.coin))
        {
            return Err(MarketError::Unavailable);
        }
        let decimals = decimals(&metadata["decimals"]).ok_or(MarketError::Unavailable)?;
        let rows = ranking["holders"]
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= limit)
            .ok_or(MarketError::Unavailable)?;
        let mut seen = HashSet::new();
        let holders = rows
            .iter()
            .map(|row| {
                let address = row["address"]
                    .as_str()
                    .filter(|address| evm(address) && seen.insert(address.to_lowercase()))?;
                Some(Holder {
                    address: address.into(),
                    balance: raw_integer(&row["rawBalance"])?,
                    label: None,
                })
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(MarketError::Unavailable)?;
        let (status, message) = if holders.len() == LIMIT {
            ("available", None)
        } else {
            (
                "partial",
                Some(format!(
                    "Binplorer 本次返回前 {} 个地址，集中度按这些地址计算。",
                    holders.len()
                )),
            )
        };
        Ok(snapshot(
            pair,
            status,
            message,
            HolderSource {
                chain: "BNB Smart Chain",
                token: Some(address),
                provider: "Binplorer",
                url: &format!("https://binplorer.com/address/{token}"),
                decimals,
            },
            holders,
            |holder| format!("https://binplorer.com/address/{holder}"),
        ))
    }

    async fn native(&self, pair: &Instrument, id: &str) -> Result<Value, MarketError> {
        let (mut holders, chain, decimals, provider, source, prefix, scope, estimated) = match id {
            "bitcoin" => {
                let url = "https://www.coinlore.com/coin/bitcoin/richlist";
                (
                    bitcoin_rows(&self.research.public_text(url).await?)?,
                    "Bitcoin",
                    8,
                    "CoinLore",
                    url,
                    "https://mempool.space/address/",
                    "仅取得来源公开的前 100 名，余额为页面展示的近似值。",
                    true,
                )
            }
            "ripple" => {
                let response = self
                    .markets
                    .http("https://api.xrpscan.com", "api/v1/balances", &[])
                    .await?;
                let rows = response
                    .as_array()
                    .filter(|rows| rows.len() >= LIMIT)
                    .ok_or(MarketError::Unavailable)?;
                let holders = rows
                    .iter()
                    .map(|row| {
                        let address = row["account"]
                            .as_str()
                            .filter(|address| base58_address(address, b'r', 24, 34))?;
                        let supply = raw_integer(&row["supply"])?;
                        let escrow = if row["escrow"].is_null() {
                            BigUint::default()
                        } else {
                            raw_integer(&row["escrow"])?
                        };
                        if supply != raw_integer(&row["balance"])? + escrow {
                            return None;
                        }
                        Some(Holder {
                            address: address.into(),
                            balance: supply,
                            label: row["name"]["name"].as_str().map(str::to_owned),
                        })
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or(MarketError::Unavailable)?;
                (
                    holders,
                    "XRP Ledger",
                    6,
                    "XRPSCAN",
                    "https://xrpscan.com/balances",
                    "https://xrpscan.com/account/",
                    "账户余额加托管（Escrow）余额，来源每晚更新。",
                    false,
                )
            }
            "tron" => {
                let mut holders = Vec::new();
                for offset in (0..LIMIT).step_by(50) {
                    let response = self
                        .markets
                        .http(
                            "https://apilist.tronscanapi.com",
                            "api/account/list",
                            &[
                                ("sort", "-balance"),
                                ("limit", "50"),
                                ("start", &offset.to_string()),
                            ],
                        )
                        .await?;
                    let rows = response["data"]
                        .as_array()
                        .filter(|rows| rows.len() == 50)
                        .ok_or(MarketError::Unavailable)?;
                    for row in rows {
                        let address = row["address"]
                            .as_str()
                            .filter(|address| base58_address(address, b'T', 33, 33))
                            .ok_or(MarketError::Unavailable)?;
                        let balance =
                            raw_integer(&row["totalBalance"]).ok_or(MarketError::Unavailable)?;
                        holders.push(Holder {
                            address: address.into(),
                            balance,
                            label: row["addressTag"].as_str().map(str::to_owned),
                        });
                    }
                }
                if holders
                    .windows(2)
                    .any(|pair| pair[0].balance < pair[1].balance)
                {
                    return Err(MarketError::Unavailable);
                }
                (
                    holders,
                    "TRON",
                    6,
                    "TRONSCAN",
                    "https://tronscan.org/#/data/accounts",
                    "https://tronscan.org/#/address/",
                    "账户总余额（含质押及解质押中的余额）。",
                    false,
                )
            }
            _ => return Err(MarketError::Unavailable),
        };
        holders.sort_by(|left, right| right.balance.cmp(&left.balance));
        holders.truncate(LIMIT);
        if holders
            .iter()
            .map(|row| &row.address)
            .collect::<HashSet<_>>()
            .len()
            != holders.len()
        {
            return Err(MarketError::Unavailable);
        }
        let (status, message) = if holders.len() == LIMIT {
            ("available", None)
        } else {
            (
                "partial",
                Some(format!(
                    "免费来源当前仅有前 {} 名，尚未取得完整前 200 名。",
                    holders.len()
                )),
            )
        };
        let mut result = snapshot(
            pair,
            status,
            message,
            HolderSource {
                chain,
                token: None,
                provider,
                url: source,
                decimals,
            },
            holders,
            |address| format!("{prefix}{address}"),
        );
        result["balanceScope"] = json!(scope);
        result["amountsEstimated"] = json!(estimated);
        Ok(result)
    }
}

fn bitcoin_rows(html: &str) -> Result<Vec<Holder>, MarketError> {
    let mut rows: Vec<Holder> = Vec::new();
    for row in html.split("<tr>").skip(1) {
        let Some((header, body)) = row
            .trim_start()
            .strip_prefix("<th")
            .and_then(|row| row.split_once("</th>"))
        else {
            continue;
        };
        let Some((attrs, rank)) = header.split_once('>') else {
            continue;
        };
        if !attrs.contains("scope=\"row\"") && !attrs.contains("scope='row'") {
            continue;
        }
        let mut cells = body.split("<td").skip(1).filter_map(|cell| {
            cell.split_once('>')?
                .1
                .split_once("</td>")
                .map(|(cell, _)| cell)
        });
        let (Some(balance), Some(address), Some(label)) =
            (cells.next(), cells.next(), cells.next())
        else {
            continue;
        };
        let valid = address.starts_with("bc1")
            && (14..=90).contains(&address.len())
            && address[3..]
                .bytes()
                .all(|byte| b"acdefghjklmnpqrstuvwxyz023456789".contains(&byte))
            || base58_address(address, b'1', 25, 34)
            || base58_address(address, b'3', 25, 34);
        if rank.parse().ok() != Some(rows.len() + 1)
            || !valid
            || rows.iter().any(|row| row.address == address)
        {
            return Err(MarketError::Unavailable);
        }
        let balance = balance.replace(',', "");
        let (whole, fraction) = balance
            .trim()
            .split_once('.')
            .unwrap_or((balance.trim(), ""));
        if whole.is_empty()
            || fraction.len() > 8
            || !whole
                .bytes()
                .chain(fraction.bytes())
                .all(|byte| byte.is_ascii_digit())
        {
            return Err(MarketError::Unavailable);
        }
        let balance =
            raw_digits(&format!("{whole}{fraction:0<8}")).ok_or(MarketError::Unavailable)?;
        if rows.last().is_some_and(|row| row.balance < balance) {
            return Err(MarketError::Unavailable);
        }
        let label: String = label
            .split('<')
            .enumerate()
            .filter_map(|(index, part)| {
                if index == 0 {
                    Some(part)
                } else {
                    part.split_once('>').map(|(_, rest)| rest)
                }
            })
            .collect();
        rows.push(Holder {
            address: address.into(),
            balance,
            label: (!label.trim().is_empty()).then(|| label.trim().to_owned()),
        });
    }
    if rows.len() != 100 {
        return Err(MarketError::Unavailable);
    }
    Ok(rows)
}

struct HolderSource<'a> {
    chain: &'a str,
    token: Option<&'a str>,
    provider: &'a str,
    url: &'a str,
    decimals: usize,
}

fn snapshot(
    pair: &Instrument,
    status: &str,
    message: Option<String>,
    source: HolderSource<'_>,
    mut holders: Vec<Holder>,
    explorer_url: impl Fn(&str) -> String,
) -> Value {
    holders.sort_by(|left, right| right.balance.cmp(&left.balance));
    let total: BigUint = holders.iter().map(|row| &row.balance).sum();
    let rows: Vec<_> = holders
        .into_iter()
        .map(|row| {
            json!({"address":row.address,"amount":token_amount(&row.balance,source.decimals),
        "label":row.label,"explorerUrl":explorer_url(&row.address)})
        })
        .collect();
    json!({"status":status,"message":message,"symbol":pair.coin,"chain":source.chain,"tokenAddress":source.token,
        "totalAmount":token_amount(&total,source.decimals),"rows":rows,"fetchedAt":now_ms(),"stale":false,
        "sourceName":source.provider,"sourceUrl":source.url})
}

fn empty(pair: &Instrument, status: &str, message: &str) -> Value {
    json!({"status":status,"message":message,"symbol":pair.coin,"chain":null,"tokenAddress":null,"totalAmount":null,"rows":[],
        "fetchedAt":now_ms(),"stale":false,"sourceName":"","sourceUrl":null})
}

fn with_valuation(mut data: Value, valuation: &Value) -> Value {
    let supply = valuation["supplyLimit"].as_str().unwrap_or("unknown");
    let cap = if supply == "capped" {
        positive(&valuation["maxSupply"])
    } else {
        None
    };
    let circulating = if supply == "unlimited" {
        positive(&valuation["circulatingMarketCap"])
            .zip(positive(&valuation["price"]))
            .map(|(cap, price)| cap / price)
    } else {
        None
    };
    let percentage = |amount: &Value, supply: Option<f64>| {
        number(amount)
            .zip(supply)
            .map(|(amount, supply)| amount / supply * 100.0)
            .filter(|pct| pct.is_finite())
    };
    data["supplyLimit"] = json!(supply);
    data["maxSupply"] = json!(cap);
    data["totalMarketCap"] = valuation["totalMarketCap"].clone();
    data["totalMarketCapPercentage"] = json!(percentage(&data["totalAmount"], cap));
    data["circulatingMarketCapPercentage"] = json!(percentage(&data["totalAmount"], circulating));
    if let Some(rows) = data["rows"].as_array_mut() {
        for row in rows {
            row["totalMarketCapPercentage"] = json!(percentage(&row["amount"], cap));
            row["circulatingMarketCapPercentage"] = json!(percentage(&row["amount"], circulating));
        }
    }
    if let Some(fields) = data.as_object_mut() {
        fields.remove("resolutionVersion");
    }
    data
}

pub fn save_snapshot(file: &Path, data: &Value) -> crate::store::Result<()> {
    let folder = file.parent().ok_or("missing cache directory")?;
    std::fs::create_dir_all(folder)?;
    let temporary = folder.join(format!("{}.tmp", Uuid::new_v4()));
    let saved = (|| {
        std::fs::write(&temporary, serde_json::to_vec(data)?)?;
        std::fs::rename(&temporary, file)?;
        Ok(())
    })();
    if saved.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    saved
}

fn token_amount(raw: &BigUint, decimals: usize) -> String {
    let digits = raw.to_str_radix(10);
    if decimals == 0 {
        return digits;
    }
    let digits = format!("{:0>width$}", digits, width = decimals + 1);
    let (whole, fraction) = digits.split_at(digits.len() - decimals);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        whole.into()
    } else {
        format!("{whole}.{fraction}")
    }
}

fn decimals(value: &Value) -> Option<usize> {
    number(value)
        .filter(|n| (0.0..=36.0).contains(n) && n.fract() == 0.0)
        .map(|n| n as usize)
}
fn raw_digits(value: &str) -> Option<BigUint> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}
fn raw_integer(value: &Value) -> Option<BigUint> {
    if let Some(value) = value.as_str() {
        raw_digits(value)
    } else {
        value
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .map(BigUint::from)
    }
}
fn evm(address: &str) -> bool {
    address.len() == 42
        && (address.starts_with("0x") || address.starts_with("0X"))
        && address.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}
fn base58_address(address: &str, prefix: u8, min: usize, max: usize) -> bool {
    address
        .as_bytes()
        .split_first()
        .is_some_and(|(first, rest)| {
            *first == prefix
                && (min..=max).contains(&rest.len())
                && rest.iter().all(|byte| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(byte)
                })
        })
}
fn has_rows(data: &Value) -> bool {
    data["rows"].as_array().is_some_and(|rows| !rows.is_empty())
}
fn bsc_key() -> String {
    std::env::var("BINPLORER_API_KEY")
        .ok()
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty())
        .unwrap_or_else(|| "freekey".into())
}
fn cacheable(data: &Value) -> bool {
    has_rows(data)
        && (data["status"] == "available"
            || data["status"] == "partial"
                && (data["amountsEstimated"] == true
                    || data["sourceName"] == "Binplorer"
                        && data["rows"]
                            .as_array()
                            .is_some_and(|rows| rows.len() == FREE_BSC_LIMIT)
                        && bsc_key() == "freekey"))
}
fn chain_id(name: &str) -> Option<u64> {
    Some(match name {
        "ethereum" => 1,
        "optimistic-ethereum" => 10,
        "binance-smart-chain" => 56,
        "xdai" => 100,
        "polygon-pos" => 137,
        "arbitrum-one" => 42161,
        "base" => 8453,
        _ => return None,
    })
}
fn explorer(chain: u64) -> Option<(&'static str, &'static str)> {
    Some(match chain {
        1 => ("Ethereum", "https://eth.blockscout.com"),
        10 => ("Optimism", "https://optimism.blockscout.com"),
        100 => ("Gnosis", "https://gnosis.blockscout.com"),
        137 => ("Polygon", "https://polygon.blockscout.com"),
        42161 => ("Arbitrum One", "https://arbitrum.blockscout.com"),
        8453 => ("Base", "https://base.blockscout.com"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_large_raw_balances_without_rounding() {
        let balance = raw_digits("999999999999999999999999999999999999999999").unwrap();
        assert_eq!(
            token_amount(&balance, 18),
            "999999999999999999999999.999999999999999999"
        );
        assert_eq!(token_amount(&BigUint::from(1_u32), 8), "0.00000001");
        assert!(raw_integer(&json!(9_007_199_254_740_992_u64)).is_none());
    }

    #[test]
    fn percentage_denominator_respects_capped_and_unlimited_supply() {
        let data = json!({"totalAmount":"250","rows":[{"amount":"25"}]});
        let capped = with_valuation(
            data.clone(),
            &json!({"supplyLimit":"capped","maxSupply":1000}),
        );
        assert_eq!(capped["totalMarketCapPercentage"], json!(25.0));
        assert!(capped["circulatingMarketCapPercentage"].is_null());
        let unlimited = with_valuation(
            data,
            &json!({"supplyLimit":"unlimited","price":2,"circulatingMarketCap":1000}),
        );
        assert_eq!(
            unlimited["rows"][0]["circulatingMarketCapPercentage"],
            json!(5.0)
        );
        assert!(unlimited["totalMarketCapPercentage"].is_null());
    }
}
