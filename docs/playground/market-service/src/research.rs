use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{Client, Url};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::binance::{number, Endpoint};
use crate::markets::{
    bundle_candidate, bundled_coin, Cache, Exchange, Instrument, Kind, MarketError, Markets,
    Snapshot,
};
use crate::now_ms;
use crate::tokenomics::{date, Unlocks};

const MINUTE: i64 = 60_000;
const REFRESH: i64 = 5 * MINUTE;
const RETRY: i64 = 30_000;
const RECENT: i64 = 20 * MINUTE;
const FALLBACK_LIMIT: usize = 8;
const COINGECKO: &str = "https://api.coingecko.com/api/v3";
const CMC: &str = "https://api.coinmarketcap.com/data-api/v3";
const CMC_QUOTES: &str = "https://pro-api.coinmarketcap.com/public-api/v2";
const BINANCE_WEBSITE: &str = "https://www.binance.com";

type Recent = HashMap<String, (f64, i64)>;
type CoinIds = HashMap<String, String>;
type SpotIds = HashMap<String, Vec<String>>;

#[derive(Default)]
struct Caps {
    cached: Option<Snapshot<Option<Value>>>,
    coin: Recent,
    contract: Recent,
    attempts: HashMap<String, i64>,
}

pub struct Research {
    markets: Arc<Markets>,
    client: Client,
    caps: Mutex<Caps>,
    ids: Mutex<Option<Snapshot<Result<CoinIds, MarketError>>>>,
    spot_ids: Mutex<Option<Snapshot<SpotIds>>>,
    verified_spot: Mutex<HashMap<String, Snapshot<Option<String>>>>,
    aliases: Value,
    stored: Value,
    unlocks: Unlocks,
    overview_cache: Cache<String, Value>,
}

impl Research {
    pub async fn overview(&self, pair: &Instrument) -> Result<Value, MarketError> {
        if pair.contract_type == "TRADIFI_PERPETUAL" {
            return Ok(
                json!({"market":null,"unlock":null,"tokenomics":null,"status":"not-applicable"}),
            );
        }
        let entry = self.overview_cache.entry(pair.id.clone()).await;
        let mut cache = entry.lock().await;
        if let Some(saved) = cache.as_ref().filter(|saved| saved.until > now_ms()) {
            return Ok(saved.value.clone());
        }
        let now = now_ms();
        let verified = verified_identity(pair);
        let identity = self.identity(pair).await;
        let identity_error = identity.is_err();
        let identity = identity.ok().flatten();
        let seed = &self.stored["contracts"][&pair.id];
        let preferred = verified.or_else(|| {
            if pair.base != pair.coin {
                identity.as_deref()
            } else {
                None
            }
        });
        let (tokenomics, cached_id) = self
            .unlocks
            .read(
                self,
                pair,
                seed,
                &self.stored,
                preferred,
                identity.as_deref(),
            )
            .await;
        let id = preferred
            .or(cached_id.as_deref())
            .or_else(|| seed["geckoId"].as_str())
            .or(identity.as_deref());
        let (row, unavailable) = match id {
            Some(id) => self.asset_market(id, coin_symbol(pair)).await,
            None => (None, false),
        };
        let row = if row.as_ref().and_then(gecko_cap).is_none() {
            self.supply_market(pair).await.or(row)
        } else {
            row
        };
        let unmapped = row.is_none() && id.is_none() && !identity_error;
        let market = row.as_ref().map(|row| {
            let cap = gecko_cap(row);
            let price = positive(&row["current_price"]);
            let max = positive(&tokenomics["maxSupply"]).or_else(||positive(&row["max_supply"]));
            let supply = tokenomics["supplyLimit"].as_str().filter(|supply|*supply!="unknown")
                .unwrap_or_else(|| if row["unlimited"]==true {"unlimited"} else if max.is_some(){"capped"}else{"unknown"});
            let total = if supply=="capped" { price.zip(max).map(|(price,max)|price*max) } else {None};
            let source=row["source"].as_str().unwrap_or("CoinGecko");
            let row_id=row["id"].as_str().unwrap_or_default();
            let url=match source {
                "币安持仓数据估算"=>"https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#open-interest-statistics".into(),
                "CoinMarketCap"=>format!("https://coinmarketcap.com/currencies/{}/",self.slug(row_id)),
                _=>format!("https://www.coingecko.com/en/coins/{row_id}"),
            };
            if let Some(cap)=cap {
                if let Ok(mut state)=self.caps.try_lock() {
                    state.contract.insert(pair.id.clone(),(cap,now));
                    if source!="币安持仓数据估算"{state.coin.insert(row_id.into(),(cap,now));}
                }
            }
            json!({"price":price,"circulatingMarketCap":cap,"totalMarketCap":total,"supplyLimit":supply,"maxSupply":max,
                "updatedAt":row["updated_at"].as_i64().or_else(||date(&row["last_updated"])),"sourceUrl":url,"sourceName":source})
        });
        let mut response = json!({"unlock":tokenomics["events"][0],"tokenomics":tokenomics,"unlockSnapshotAt":tokenomics["updatedAt"],
            "market":market,"status":if unmapped{"unmapped"}else{"ready"}});
        if !unmapped {
            response["marketError"] = json!(row.is_none() && (identity_error || unavailable));
        }
        *cache = Some(Snapshot {
            value: response.clone(),
            until: now_ms() + MINUTE,
        });
        Ok(response)
    }

    async fn asset_market(&self, id: &str, symbol: &str) -> (Option<Value>, bool) {
        if !valid_slug(id) {
            return (None, false);
        }
        let gecko = self
            .gecko(
                "coins/markets",
                &[("vs_currency", "usd"), ("ids", id), ("per_page", "1")],
            )
            .await;
        let failed = gecko.is_err();
        let gecko = gecko
            .ok()
            .and_then(|rows| rows.as_array()?.iter().find(|row| row["id"] == id).cloned());
        if gecko.as_ref().and_then(gecko_cap).is_some() {
            return (gecko, false);
        }
        let cmc = self.cmc_details(id,symbol).await.ok().flatten().map(|row| {
            let stats=&row["statistics"];
            json!({"id":id,"symbol":row["symbol"],"current_price":stats["price"],"market_cap":stats["marketCap"],
                "circulating_supply":stats["circulatingSupply"],"max_supply":stats["maxSupply"],"unlimited":row["isInfiniteMaxSupply"]==1,
                "last_updated":stats.get("lastUpdated").filter(|date| !date.is_null()).unwrap_or(&row["lastUpdated"]),"source":"CoinMarketCap"})
        });
        if cmc.as_ref().and_then(gecko_cap).is_some() {
            (cmc, false)
        } else if let Some(row) = gecko.or(cmc) {
            (Some(row), false)
        } else {
            (None, failed)
        }
    }

    pub async fn public_json(
        &self,
        url: Url,
        header: Option<(&str, &str)>,
    ) -> Result<Value, MarketError> {
        let mut request = self.client.get(url);
        if let Some((name, value)) = header {
            request = request.header(name, value);
        }
        request
            .send()
            .await
            .map_err(|_| MarketError::Unavailable)?
            .error_for_status()
            .map_err(|_| MarketError::Unavailable)?
            .json()
            .await
            .map_err(|_| MarketError::Unavailable)
    }
    pub async fn identity(&self, pair: &Instrument) -> Result<Option<String>, MarketError> {
        match self.listed_identity(pair).await {
            Ok(Some(id)) => Ok(Some(id)),
            Ok(None) => self.spot_identity(&pair.coin).await,
            Err(error) => self.spot_identity(&pair.coin).await?.ok_or(error).map(Some),
        }
    }

    pub async fn cmc_details(&self, id: &str, symbol: &str) -> Result<Option<Value>, MarketError> {
        let slug = self.slug(id);
        let response = self
            .markets
            .http(CMC, "cryptocurrency/detail", &[("slug", slug)])
            .await?;
        let row = &response["data"];
        Ok((row["slug"] == slug
            && row["symbol"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(symbol))
            && row["statistics"].is_object())
        .then(|| row.clone()))
    }

    pub async fn platforms(&self, id: &str, symbol: &str) -> Result<Option<Value>, MarketError> {
        if !valid_slug(id) {
            return Ok(None);
        }
        let row = self
            .gecko(
                &format!("coins/{id}"),
                &[
                    ("localization", "false"),
                    ("tickers", "false"),
                    ("market_data", "false"),
                    ("community_data", "false"),
                    ("developer_data", "false"),
                ],
            )
            .await?;
        Ok((row["id"] == id
            && row["symbol"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(symbol)))
        .then_some(row))
    }

    pub async fn public_text(&self, url: &str) -> Result<String, MarketError> {
        self.client
            .get(url)
            .send()
            .await
            .map_err(|_| MarketError::Unavailable)?
            .error_for_status()
            .map_err(|_| MarketError::Unavailable)?
            .text()
            .await
            .map_err(|_| MarketError::Unavailable)
    }
    pub async fn daily_market_caps(
        &self,
        pair: &Instrument,
        days: i64,
    ) -> Result<Vec<(i64, f64)>, MarketError> {
        let listed = self.listed_identity(pair).await;
        let id = match listed {
            Ok(Some(id)) => Some(id),
            Ok(None) => self.spot_identity(&pair.coin).await?,
            Err(error) => self
                .spot_identity(&pair.coin)
                .await?
                .ok_or(error)
                .map(Some)?,
        };
        let Some(id) = id.filter(|id| valid_slug(id)) else {
            return Ok(Vec::new());
        };
        let response = self
            .gecko(
                &format!("coins/{id}/market_chart"),
                &[
                    ("vs_currency", "usd"),
                    ("days", &days.to_string()),
                    ("interval", "daily"),
                ],
            )
            .await?;
        Ok(response["market_caps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| Some((row[0].as_i64()?, positive(&row[1])?)))
            .collect())
    }

    pub fn new(markets: Arc<Markets>) -> crate::store::Result<Self> {
        let client = Client::builder()
            .user_agent(crate::HTTP_USER_AGENT)
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let unlocks = Unlocks::new(Arc::clone(&markets))?;
        Ok(Self {
            markets,
            client,
            caps: Mutex::new(Caps::default()),
            ids: Mutex::new(None),
            spot_ids: Mutex::new(None),
            verified_spot: Mutex::new(HashMap::new()),
            aliases: serde_json::from_str(include_str!("../../lib/coin-source-aliases.json"))?,
            stored: serde_json::from_str(include_str!("../../lib/coin-unlock-snapshot.json"))?,
            unlocks,
            overview_cache: Cache::new(),
        })
    }

    pub async fn contract_caps(&self) -> Result<Value, MarketError> {
        let mut state = self.caps.lock().await;
        if let Some(cache) = state.cached.as_ref().filter(|cache| cache.until > now_ms()) {
            return cache.value.clone().ok_or(MarketError::Unavailable);
        }
        let loaded = self.load_caps(&mut state).await;
        let incomplete = loaded
            .as_ref()
            .map_or(true, |result| result["incomplete"] == true);
        state.cached = Some(Snapshot {
            until: now_ms() + if incomplete { RETRY } else { REFRESH },
            value: loaded.as_ref().ok().cloned(),
        });
        loaded
    }

    async fn load_caps(&self, state: &mut Caps) -> Result<Value, MarketError> {
        let listed: Vec<_> = self
            .markets
            .binance_contracts()
            .await?
            .into_iter()
            .filter(|pair| pair.contract_type == "PERPETUAL")
            .collect();
        let mut caps = self.binance_caps(&listed).await.unwrap_or_default();
        let now = now_ms();
        state.coin.retain(|_, (_, time)| *time + RECENT > now);
        state.contract.retain(|_, (_, time)| *time + RECENT > now);
        state.contract.extend(
            caps.iter()
                .map(|(symbol, value)| (symbol.clone(), (*value, now))),
        );
        let missing: Vec<_> = listed
            .iter()
            .filter(|pair| !caps.contains_key(&pair.id))
            .collect();
        let mut mappings = Vec::with_capacity(missing.len());
        let mut coins = HashMap::new();
        let mut incomplete = false;
        for pair in &missing {
            let mapping = self.listed_identity(pair).await;
            if let Ok(Some(id)) = &mapping {
                coins.insert(id.clone(), coin_symbol(pair).to_owned());
            }
            incomplete |= mapping.is_err();
            mappings.push(mapping);
        }
        let mut failed = HashSet::new();
        let mut ids: Vec<_> = coins
            .keys()
            .filter(|id| recent(&state.coin, id, MINUTE).is_none())
            .cloned()
            .collect();
        ids.sort_unstable();
        for batch in ids.chunks(100) {
            let params = [
                ("vs_currency", "usd"),
                ("ids", &batch.join(",")),
                ("per_page", &batch.len().to_string()),
            ];
            match self.gecko("coins/markets", &params).await {
                Ok(rows) if rows.is_array() => {
                    for row in rows.as_array().into_iter().flatten() {
                        if let Some((id, cap)) = row["id"]
                            .as_str()
                            .zip(gecko_cap(row))
                            .filter(|(id, _)| coins.contains_key(*id))
                        {
                            state.coin.insert(id.to_owned(), (cap, now_ms()));
                        }
                    }
                }
                _ => failed.extend(batch.iter().cloned()),
            }
        }
        incomplete |= !failed.is_empty();
        if self.fill_cmc(&coins, &mut state.coin).await.is_err() {
            incomplete = true;
        }
        let mut verified = Vec::new();
        let mut other = Vec::new();
        for (pair, mapping) in missing.iter().zip(&mappings) {
            let id = mapping.as_ref().ok().and_then(Option::as_deref);
            if recent(&state.contract, &pair.id, RECENT).is_some()
                || id.is_some_and(|id| recent(&state.coin, id, RECENT).is_some())
            {
                continue;
            }
            if verified_identity(pair).is_some() {
                verified.push((*pair, id));
            } else {
                other.push((*pair, id));
            }
        }
        other.sort_by_key(|(pair, _)| state.attempts.get(&pair.id).copied().unwrap_or_default());
        let deferred: HashSet<_> = other
            .iter()
            .skip(FALLBACK_LIMIT)
            .map(|(pair, _)| pair.id.as_str())
            .collect();
        incomplete |= !deferred.is_empty();
        for (pair, id) in verified
            .into_iter()
            .chain(other.iter().take(FALLBACK_LIMIT).copied())
        {
            state.attempts.insert(pair.id.clone(), now_ms());
            let id = match id {
                Some(id) => Some(id.to_owned()),
                None => self.spot_identity(&pair.coin).await.ok().flatten(),
            };
            if let Some(id) = id {
                if let Some(cap) = recent(&state.coin, &id, RECENT) {
                    state.contract.insert(pair.id.clone(), (cap, now_ms()));
                    continue;
                }
                if let Some(cap) = self.cmc_cap(&id, coin_symbol(pair)).await {
                    state.coin.insert(id, (cap, now_ms()));
                    state.contract.insert(pair.id.clone(), (cap, now_ms()));
                    continue;
                }
            }
            if let Some(cap) = self.supply_estimate(pair).await {
                state.contract.insert(pair.id.clone(), (cap, now_ms()));
            }
        }
        let mut gaps = Vec::new();
        for (pair, mapping) in missing.into_iter().zip(mappings) {
            let id = mapping.as_ref().ok().and_then(Option::as_deref);
            if let Some(cap) = id
                .and_then(|id| recent(&state.coin, id, RECENT))
                .or_else(|| recent(&state.contract, &pair.id, RECENT))
            {
                caps.insert(pair.id.clone(), cap);
            } else {
                let reason = if deferred.contains(pair.id.as_str()) {
                    "fallback-pending"
                } else {
                    match mapping {
                        Err(_) => "identity-unavailable",
                        Ok(None) => "unmapped",
                        Ok(Some(id)) if failed.contains(&id) => "cap-unavailable",
                        _ => "cap-missing",
                    }
                };
                gaps.push(json!({"symbol":pair.id,"reason":reason}));
            }
        }
        if incomplete && caps.is_empty() {
            return Err(MarketError::Unavailable);
        }
        Ok(
            json!({"caps":caps,"total":listed.len(),"incomplete":incomplete && !gaps.is_empty(),"missing":gaps}),
        )
    }

    async fn binance_caps(
        &self,
        listed: &[Instrument],
    ) -> Result<HashMap<String, f64>, MarketError> {
        let response = self
            .markets
            .http(
                BINANCE_WEBSITE,
                "bapi/composite/v1/public/marketing/symbol/list",
                &[],
            )
            .await?;
        if response["code"] != "000000" || response["success"] == false {
            return Err(MarketError::Unavailable);
        }
        let data = response["data"]
            .as_array()
            .ok_or(MarketError::Unavailable)?;
        let by_symbol: HashMap<_, _> = data
            .iter()
            .filter_map(|row| {
                let base = row["baseAsset"].as_str().filter(|base| !base.is_empty())?;
                let symbol = row["symbol"].as_str()?;
                let cap = positive(&row["marketCap"])?;
                (row["quoteAsset"] == "USDT" && symbol.strip_suffix("USDT") == Some(base))
                    .then_some((symbol, (base, cap)))
            })
            .collect();
        Ok(listed
            .iter()
            .filter_map(|pair| {
                if let Some((_, cap)) = by_symbol
                    .get(pair.id.as_str())
                    .filter(|(base, _)| *base == pair.base)
                {
                    return Some((pair.id.clone(), *cap));
                }
                let bundle =
                    bundled_coin(&pair.base).filter(|bundle| *bundle == coin_symbol(pair))?;
                let (_, cap) = by_symbol.get(format!("{bundle}USDT").as_str())?;
                Some((pair.id.clone(), *cap))
            })
            .collect())
    }

    async fn listed_identity(&self, pair: &Instrument) -> Result<Option<String>, MarketError> {
        if let Some(id) = verified_identity(pair).or_else(|| {
            if pair.base == pair.coin {
                self.stored["contracts"][&pair.id]["geckoId"].as_str()
            } else {
                None
            }
        }) {
            return Ok(Some(id.to_owned()));
        }
        if pair.base != pair.coin {
            if let Some(id) = self.spot_identity(&pair.coin).await.ok().flatten() {
                return Ok(Some(id));
            }
        }
        let mut ids = self.ids.lock().await;
        if let Some(cache) = ids.as_ref().filter(|entry| entry.until > now_ms()) {
            return cache
                .value
                .as_ref()
                .map(|map| map.get(&pair.id).cloned())
                .map_err(|error| *error);
        }
        let map = self
            .gecko(
                "derivatives/exchanges/binance_futures",
                &[("include_tickers", "all")],
            )
            .await
            .and_then(|response| {
                let rows = response["tickers"]
                    .as_array()
                    .ok_or(MarketError::Unavailable)?;
                Ok(rows
                    .iter()
                    .filter(|row| row["target"] == "USDT" && row["contract_type"] == "perpetual")
                    .filter_map(|row| {
                        Some((
                            row["symbol"].as_str()?.to_owned(),
                            row["coin_id"]
                                .as_str()
                                .filter(|id| !id.is_empty())?
                                .to_owned(),
                        ))
                    })
                    .collect::<HashMap<_, _>>())
            });
        let result = map
            .as_ref()
            .map(|map| map.get(&pair.id).cloned())
            .map_err(|error| *error);
        let duration = if map.is_ok() { 30 * MINUTE } else { RETRY };
        *ids = Some(Snapshot {
            value: map,
            until: now_ms() + duration,
        });
        result
    }

    async fn spot_identity(&self, coin: &str) -> Result<Option<String>, MarketError> {
        if let Some(cached) = self
            .verified_spot
            .lock()
            .await
            .get(coin)
            .filter(|entry| entry.until > now_ms())
        {
            return Ok(cached.value.clone());
        }
        match self
            .markets
            .instrument(Exchange::Binance, Kind::Spot, &format!("{coin}USDT"))
            .await
        {
            Ok(pair) if pair.base == coin && pair.quote == "USDT" => {}
            Err(MarketError::Missing) | Ok(_) => return Ok(None),
            Err(error) => return Err(error),
        }
        let ids = {
            let mut cache = self.spot_ids.lock().await;
            if let Some(entry) = cache.as_ref().filter(|entry| entry.until > now_ms()) {
                entry.value.get(coin).cloned()
            } else {
                let rows = self.gecko("coins/list", &[]).await?;
                let mut map = SpotIds::new();
                for row in rows.as_array().ok_or(MarketError::Unavailable)? {
                    if let Some((id, symbol)) = row["id"].as_str().zip(row["symbol"].as_str()) {
                        map.entry(symbol.to_uppercase())
                            .or_default()
                            .push(id.to_owned());
                    }
                }
                let ids = map.get(coin).cloned();
                *cache = Some(Snapshot {
                    value: map,
                    until: now_ms() + 30 * MINUTE,
                });
                ids
            }
        };
        let result = if let Some(ids) = ids.filter(|ids| !ids.is_empty()) {
            let data = self
                .gecko("exchanges/binance/tickers", &[("coin_ids", &ids.join(","))])
                .await?;
            let matches: HashSet<_> = data["tickers"]
                .as_array()
                .ok_or(MarketError::Unavailable)?
                .iter()
                .filter(|row| row["base"] == coin && row["target"] == "USDT")
                .filter_map(|row| {
                    row["coin_id"]
                        .as_str()
                        .filter(|id| ids.iter().any(|candidate| candidate == id))
                })
                .collect();
            (matches.len() == 1).then(|| matches.into_iter().next().unwrap().to_owned())
        } else {
            None
        };
        self.verified_spot.lock().await.insert(
            coin.to_owned(),
            Snapshot {
                value: result.clone(),
                until: now_ms() + 30 * MINUTE,
            },
        );
        Ok(result)
    }

    pub fn slug<'a>(&'a self, id: &'a str) -> &'a str {
        self.aliases[id].as_str().unwrap_or(id)
    }

    async fn fill_cmc(&self, coins: &CoinIds, caps: &mut Recent) -> Result<(), MarketError> {
        let missing: Vec<_> = coins
            .iter()
            .filter(|(id, _)| recent(caps, id, REFRESH).is_none() && valid_slug(self.slug(id)))
            .collect();
        for batch in missing.chunks(100) {
            let slugs: HashSet<_> = batch.iter().map(|(id, _)| self.slug(id)).collect();
            let slugs = slugs.into_iter().collect::<Vec<_>>().join(",");
            let result = self
                .markets
                .http(
                    CMC_QUOTES,
                    "simple/price",
                    &[
                        ("slug", &slugs),
                        ("convert", "USD"),
                        ("include_market_cap", "true"),
                        ("skip_invalid", "true"),
                    ],
                )
                .await?;
            let rows = result["data"].as_array().ok_or(MarketError::Unavailable)?;
            let by_slug: HashMap<_, _> = rows
                .iter()
                .filter_map(|row| Some((row["slug"].as_str()?, row)))
                .collect();
            for (id, symbol) in batch {
                let Some(row) = by_slug.get(self.slug(id)).filter(|row| {
                    row["symbol"]
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(symbol))
                }) else {
                    continue;
                };
                if let Some(cap) = row["quotes"]
                    .as_array()
                    .and_then(|quotes| quotes.iter().find(|quote| quote["symbol"] == "USD"))
                    .and_then(|quote| positive(&quote["market_cap"]))
                {
                    caps.insert((*id).clone(), (cap, now_ms()));
                }
            }
        }
        Ok(())
    }

    async fn cmc_cap(&self, id: &str, symbol: &str) -> Option<f64> {
        let slug = self.slug(id);
        let response = self
            .markets
            .http(CMC, "cryptocurrency/detail", &[("slug", slug)])
            .await
            .ok()?;
        let row = &response["data"];
        if row["slug"] != slug
            || !row["symbol"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(symbol))
        {
            return None;
        }
        let stats = &row["statistics"];
        positive(&stats["marketCap"]).or_else(|| {
            positive(&stats["price"])
                .zip(positive(&stats["circulatingSupply"]))
                .map(|(price, supply)| price * supply)
                .filter(|cap| cap.is_finite())
        })
    }

    async fn supply_estimate(&self, pair: &Instrument) -> Option<f64> {
        self.supply_market(pair).await.as_ref().and_then(gecko_cap)
    }

    async fn supply_market(&self, pair: &Instrument) -> Option<Value> {
        if pair.contract_type != "PERPETUAL"
            || pair.base != pair.coin
            || bundled_coin(&pair.base).is_some()
            || bundle_candidate(&pair.base).is_some()
            || pair.base.bytes().take_while(u8::is_ascii_digit).count() >= 3
        {
            return None;
        }
        let mut rows: Vec<Value> = self
            .markets
            .binance
            .get(
                Endpoint::OpenInterestHistory,
                json!({"symbol":pair.id,"period":"5m","limit":3}),
            )
            .await
            .ok()?;
        rows.sort_by_key(|row| std::cmp::Reverse(row["timestamp"].as_i64().unwrap_or_default()));
        let now = now_ms();
        rows.iter()
            .filter(|row| {
                row["symbol"] == pair.id
                    && row["timestamp"]
                        .as_i64()
                        .is_some_and(|time| (now - 15 * MINUTE..=now).contains(&time))
            })
            .find_map(|row| {
                let price = positive(&row["sumOpenInterestValue"])? / positive(&row["sumOpenInterest"])?;
                let cap = price * positive(&row["CMCCirculatingSupply"])?;
                (cap.is_finite() && cap > 0.0 && price.is_finite()).then(||json!({"id":pair.id,"symbol":pair.coin,
                    "current_price":price,"market_cap":cap,"updated_at":row["timestamp"],"source":"币安持仓数据估算"}))
            })
    }

    async fn gecko(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, MarketError> {
        let mut request = self.client.get(format!("{COINGECKO}/{path}")).query(query);
        if let Some(key) = std::env::var_os("COINGECKO_DEMO_API_KEY").filter(|key| !key.is_empty())
        {
            request = request.header("x-cg-demo-api-key", key.to_string_lossy().as_ref());
        }
        request
            .send()
            .await
            .map_err(|_| MarketError::Unavailable)?
            .error_for_status()
            .map_err(|_| MarketError::Unavailable)?
            .json()
            .await
            .map_err(|_| MarketError::Unavailable)
    }
}

fn verified_identity(pair: &Instrument) -> Option<&'static str> {
    Some(match pair.base.as_str() {
        "1000SHIB" => "shiba-inu",
        "1000XEC" => "ecash",
        "1000LUNC" => "terra-luna",
        "1000PEPE" => "pepe",
        "1000FLOKI" => "floki",
        "1000BONK" => "bonk",
        "1000000MOG" => "mog-coin",
        "1000CAT" => "simons-cat",
        "1000CHEEMS" => "cheems-token",
        "1000SATS" => "sats-ordinals",
        "1000RATS" => "rats",
        "1MBABYDOGE" => "baby-doge-coin",
        _ if pair.id == "USTCUSDT" => "terrausd",
        _ => return None,
    })
}

pub fn coin_symbol(pair: &Instrument) -> &str {
    match pair.base.as_str() {
        "1000CAT" => "CAT",
        "1000CHEEMS" => "CHEEMS",
        "1000SATS" => "SATS",
        "1000RATS" => "RATS",
        "1MBABYDOGE" => "BABYDOGE",
        _ => &pair.coin,
    }
}

pub fn positive(value: &Value) -> Option<f64> {
    number(value).filter(|value| *value > 0.0)
}
fn gecko_cap(row: &Value) -> Option<f64> {
    positive(&row["market_cap"]).or_else(|| {
        positive(&row["current_price"])
            .zip(positive(&row["circulating_supply"]))
            .map(|(price, supply)| price * supply)
            .filter(|value| value.is_finite())
    })
}
fn recent(cache: &Recent, id: &str, max_age: i64) -> Option<f64> {
    cache
        .get(id)
        .filter(|(_, timestamp)| now_ms() - timestamp < max_age)
        .map(|(cap, _)| *cap)
}
fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
