# CCXT Playground

An online IDE that runs [CCXT](https://github.com/ccxt/ccxt) against **live public
exchange endpoints** in multiple languages, with an AI assistant that writes the
code for you.

- **Languages:** TypeScript, Python, PHP, **Go**, **C#** and **Java** all run
  in the playground. The AI assistant writes code for all six.
  - TypeScript runs natively on Node (`--experimental-transform-types`, no tsc) — so
    `enum`/`namespace`/parameter properties work, but types are erased, not checked.
  - Go (~2–3s/run), C# (~3–4s/run) and Java (~1s/run) compile each run, but only
    the user's file recompiles against a pre-resolved ccxt, so they stay fast.
- **Editor:** Monaco (the VS Code editor) with syntax highlighting per language,
  and **CCXT IntelliSense for TypeScript** — `exchange.` autocompletes every unified
  method with signatures and JSDoc. This uses Monaco's built-in TypeScript
  service (no language server): `/api/ccxt-types` serves CCXT's base `.d.ts`
  files plus a synthetic module entry typing each exchange as `Exchange`, which
  the editor loads via `addExtraLib` (`components/Editor.tsx`). Semantic
  autocomplete for Python/PHP/Go/C#/Java would require a real LSP per language.
- **Execution:** a backend executor spawns the real interpreter for each language
  using a pinned CCXT install, so you get real responses from real exchanges.
- **AI assistant:** streamed from the chat-completions endpoint in
  `PLAYGROUND_AI_URL`; every code answer covers all six languages at once — the
  sidebar shows **only** the language tab you have selected (Insert ready as soon
  as that block finishes streaming). One Insert files that tab immediately; the
  other languages fill their editor buffers silently in the background. The
  playground holds no inference credential: it posts `{stream, messages}` and
  streams the reply back, so the endpoint owns the backend and its keys.

## Quick start

On Windows, double-click `start-playground.cmd` at the repository root. When
the server is ready, open <http://127.0.0.1:3000/>. From a terminal, pass a
different port as the first argument if needed, for example
`start-playground.cmd 3001`.

In development, source changes are applied by Fast Refresh. Development
uses `.next-dev` and production builds use `.next`, so running a production
build does not overwrite assets served by the development server.

```bash
cd docs/playground
npm install
npm run setup-runtimes        # optional but recommended (see below)
cp .env.example .env.local    # set PLAYGROUND_AI_URL for the AI panel
npm run dev                   # http://localhost:3000
```

The local homepage lists coins with an active USDT-margined perpetual
contract on Binance. Select a coin and switch platforms to view its
USDT-quoted pairs across Binance and OKX. The USDT filter also
applies to Binance Alpha. Markets with multiple pairs offer a pair selector.
Alpha pairs are grouped by coin symbol and include their Binance ID and,
when available, their chain and token address to distinguish same-name tokens.

The price movement monitor stores its DingTalk notification preference separately
from price monitoring. The monitor watches the full live Binance USDT perpetual
directory shared with coin research. Both sections count each coin once,
including when a coin has several contracts.

The contract market-cap API starts with one bulk request to the Binance website's market
catalog and matches its circulating market caps to the USDⓈ-M contract
directory. For missing assets it shares the overview's CoinGecko and
CoinMarketCap sources, matching CoinMarketCap batch quotes by slug and
symbol. It then checks remaining assets in batches of individual requests.
Partial results refresh sooner to continue coverage.
If neither source provides a usable market cap, compatible contracts can
use an estimate from Binance's open-interest snapshot and circulating supply.
The token overview displays current circulating and maximum-supply market
caps once per asset.

After a confirmed alert, the monitor uses recent taker trades, near-midpoint
depth, and estimated liquidation pressure to forecast the move when there is
sufficient directional evidence and a fresh price. Open interest change and holder
concentration scale the estimated move. An unusually large aggregate fill
is a proxy for aggressive buying or selling.

The forecast fixes the baseline at publication and settles on the first
one-minute candle close at least five minutes later. The table compares the
estimated move with the realized move and reports direction hits and mean
absolute error in percentage points over settled forecasts in the latest
100 alert samples. Records stay in the browser and due forecasts can settle
after reopening the page. Alerts without a forecast show their data status
and are excluded from settlement and accuracy statistics.

Research shows the Binance long/short liquidation risk chart. The snapshot
API at GET /api/markets/liquidations?symbol=JCTUSDT returns price bands and
their openInterestShare and riskLevel. The chart grades modeled position
concentration if the mark price reaches each band. It exposes the price
bounds, direction, mark price and snapshot coverage. The API also retains
the modeled band notional fields for strategy calculations.

Live estimates and alert replay allocate new positions across 1x, 2x,
3x, 4x, 5x, 7x, 10x, 20x, and 50x. Both paths read the Binance public leverage
and margin schedule and use `binance-position-calibrated-2026-11-20`. A contract
with a maximum below 50x receives the 50x
weight at 20x. If its maximum is below 20x, all weight above that maximum
is assigned to the maximum.
The server fetches
the full public table in one request and caches validated schedules by symbol
for one hour. When a refresh fails or omits a symbol, its last validated
schedule can be used for up to 24 hours from its fetch time. A new estimate
requires a complete exchange schedule. Trigger prices use the maintenance rate and deduction
for the modeled account notional at the trigger. Representative entry
notionals are twice the first bracket cap, limited to 95% of the largest cap
permitted at that leverage.
The model prefers the longest complete 360-, 180-, 60-, or 30-day
CoinGecko daily circulating market-cap window and can use a complete 30- or
7-day Binance/CMC window as a fallback.
Contracts listed on Binance for less than 30 days can use available
post-listing daily samples. The cap bands have upper bounds of USD 30M,
200M, 1B, 4.5B, 15B, and 45B, with the last band starting at 45B. The factors
from lowest to highest are 0.4681, 0.6029, 0.7765, 1.0000, 1.2879, 1.6586,
and 2.1361. Without market cap history, BTCUSDT and ETHUSDT use the highest band
and other contracts use the neutral band (1.0000).

At each modelled opening, count five-minute mark-price candles in the previous
24 hours whose range (high minus low, divided by open) strictly exceeds each
of 0.5%, 1%, 2%, 4%, and 8%. Use the highest threshold exceeded by at least five
of the 288 completed candles. Levels 1 to 6 use factors of 1.0000, 0.6970,
0.4858, 0.3386, 0.2360, and 0.1645. The level falls as qualifying candles leave the
rolling window. Level 1 (1.00) applies if no threshold
qualifies or the window is incomplete. Once opened, each modeled cohort keeps
its leverage. The latest `leverageWeighting` describes newly opened positions.
The API exposes the market-cap, volatility, and combined factors, and the
panel shows the current long and short weights and effective margin rates.

The table gives the starting allocations at a combined factor of 1.

| Position side | 1x | 2x | 3x | 4x | 5x | 7x | 10x | 20x | 50x |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Long | 65.3934% | 20.9614% | 5.7870% | 3.2557% | 0.1497% | 0.0050% | 3.0976% | 0.7774% | 0.5728% |
| Short | 50.4771% | 40.1545% | 2.9852% | 5.8738% | 0.2741% | 0.0050% | 0.0050% | 0.0050% | 0.2202% |
| Effective margin at 0.5% maintenance | 100.00% | 64.85% | 43.18% | 32.35% | 20.00% | 14.29% | 10.00% | 3.65% | 1.55% |

Multiply the 5x, 7x, 10x, 20x, and 50x base weights by the product of the
market-cap and volatility factors. The remainder goes to 1x through 4x in
order, using 68.5483%, 21.9727%, 6.0662%, and 3.4128% for longs and
50.7355%, 40.3601%, 3.0005%, and 5.9039% for shorts.
Each allocation creates one modeled cohort for its side, entry and leverage.
For each leverage after fallback, derive an effective maintenance rate from the
Binance bracket rate minus its deduction divided by the representative notional.
The effective margin rate adds a calibrated multiple of the buffer between that
rate and `1 / leverage`. The multipliers for 1x through 4x, above 4x through 10x,
and above 10x are 1.30, 1.00, and 0.70. The 1x rate is capped at 100%.
The model multiplies entry price by the effective margin rate to get margin per
unit. Individual account balances, deposit timing, and fees are outside the inputs.
The reconstruction starts with no modeled positions. The first observed open
interest is the baseline for measuring changes; existing positions at that
point are not assigned entry or liquidation prices. The model adds positions
from later net increases and estimated turnover. Net increases use the
five-minute mark close as the entry proxy.
Nonpositive liquidation prices are excluded from price bands.
`positionAddScenario` assigns up to 20% of a positive open-interest change
per side to one-time adds to surviving cohorts. A cohort must have closed at
least halfway from its entry to its liquidation price. The added tranche uses
the same leverage and effective margin rate. The model assigns size only where
the combined liquidation price moves farther from the mark, with a cap of 25%
of each eligible cohort's surviving size. It deducts allocated size from the
same-side quantity available for new cohorts. This is an uncalibrated scenario.
The model removes levels crossed by the mark after formation and uses regular
contract candle volume to estimate position exits and replacements. After
accounting for the absolute net open-interest change, it assigns 50% of the
remaining volume equally to offsetting double opens and double closes. The
rest is single-side turnover.
For rising candles, 65% of single-side turnover is assigned to long exits
and 35% to short exits. Falling candles reverse those shares. Flat candles,
or candles without a verified open, use equal shares. Single-side turnover
uses the contract's five-minute volume-weighted average trade price for new
entries, computed as quote volume divided by base volume. It falls back to the
mark close if the average is unavailable. Net OI increases and replacements
from offsetting double opens use the mark close. For each side, offsetting
double closes and single-side turnover apply exponential retention to the
stock remaining after the net OI reduction, with mean open interest as the
rate denominator.
Cohorts crossed earlier in the candle are removed first. Their quantities
offset same-side net OI reductions, then offsetting double closes, then
single-side turnover. Net OI reductions exit profitable cohorts proportionally,
then other eligible and unidentified starting stock proportionally. Losing
positions whose mark close moves at least halfway toward
their liquidation trigger are used last for net reductions.
For each side, the remaining exit quantity from offsetting double closes and
turnover is split in a 60/30/9/1 ratio. The 60% share favors smaller absolute
moves from entry, with
greater distance from the liquidation trigger as a tie-breaker. The 30% share
uses unidentified starting stock first, then the earliest opening times among
cohorts eligible for the main allocation. Equal opening times favor greater
distance from liquidation. The 9% share goes to the positions with the highest
positive returns first. The 60% and 9% allocations use a reference price that blends
mark close and trade VWAP by the respective remaining double-close and turnover
exit quantities. The 1% share is allocated proportionally across near-liquidation
losing positions. Unfilled 30%, 9%, and 1% shares go to the 60% allocation. If
that allocation exhausts eligible modeled positions, it uses unidentified starting stock and
then remaining near-liquidation positions proportionally. These exits retain the
trigger and collateral of surviving positions. `positionExitScenario` records
these model parameters in live and replay responses.
Gross turnover can exceed endpoint open interest because a position can change
hands repeatedly. Estimated surviving new exposure enters the model at the
next candle boundary. If reported volume is below the absolute net open-interest change, the
model uses only the net open-interest update.
Each band is 1% of the current mark price. Divide the sum of its modeled
position quantities by the latest open interest on the same side. Shares
of at least 6% are extreme risk, 3% to below 6% are high risk, 0.25% to below
3% are elevated, and other occupied bands are low risk. The chart refreshes about once a
minute. Every high- and extreme-risk band can be selected in the list, which shows up
to three entries per side at a time and scrolls for the rest.
The grades express modeled exposure conditional on price reaching the band.
The coverage field divides each side’s charted quantity by the same open
interest, showing the nonnegative remainder as unassigned.

The live estimate requires a full 24-hour window of five-minute open interest,
mark candles, and contract volume. For contracts listed within that window,
it starts at the first published open-interest point after listing. Missing
data inside the required range causes the estimate to fail. Earlier mark
candles supply volatility inputs for the positions opened near the start.

Opening a contract’s risk chart also subscribes to Binance USDⓈ-M Futures
at `/market/ws/<symbol>@forceOrder`. The panel sums completed orders with
positive filled quantity by exchange trade time in five-minute windows.
A SELL is a long liquidation, and a BUY is a short liquidation. Each
reported amount is average fill price times cumulative filled quantity.

The model uses the latest snapshot received by the window's opening time,
with market data no more than three minutes old. After the mark candle
closes, its low triggers long positions and its high triggers short
positions. The model sums each reached position's quantity times its
liquidation price. The table shows both sides, their total, the difference
from Binance, and the relative error where the reported amount is positive.
The public stream is sampled. The table labels partial coverage and
withholds differences when a window lacks a prior snapshot or continuous
stream coverage. Each visit starts a new in-memory session with up to 48
closed windows. A closed connection retries automatically.

The historical risk-band backtest API uses GET /api/markets/liquidations/backtest?symbol=INITUSDT.
The replay warms up the same position model as the live chart for 24 hours
or from listing. For each five-minute test interval it rebuilds the same 1%
risk bands using the latest close already known five minutes before the
target interval begins. It keeps bands with at least 3% of their side’s
outstanding positions. No target-interval prices determine the prediction.

A platform event is at least 10,000 USD in recorded liquidations for one
contract, direction and interval. CryptoHFTData uses USDT. The backtest
puts each priced fill in the predicted band containing its price. Band
bounds include the lower price and exclude the upper price. An event is a
hit if the total in any one predicted band reaches the same 10,000 threshold.
The event detail shows observed prices, amounts, and each predicted band.

Missing snapshots or incomplete prices leave a case undetermined unless
the priced fills already prove a hit. Hit rate divides hits by the number
of hits and misses. The Swolecharts time series supplies aggregate amounts,
so its large-event count is visible with band results undetermined.
CoinBoss supplies order records with prices when available. CryptoHFTData
supplies hourly archives with average fill prices and filled quantities.
Providers are compared separately. The window ends one bar before the latest
five-minute boundary to allow open interest to publish.

The earlier `binance-swolecharts-2026-11-19` profile used tiers up to 100x.
Its calibration fitted 47 contracts using the seven days
ending November 12 at 11:00 UTC. The following seven days were held out.
On 82 contracts with comparable observations, the median absolute percentage
error of the seven-day total fell from 85.5% to 64.0%. The new estimate was
closer for 65 contracts. The pooled total moved from 3.0% below the reference
to 12.7% above it. For the 35 contracts excluded from training, the median
error fell from 86.0% to 67.6%. Weight normalization and leverage ceilings
were verified for the 764 active Binance USDT perpetuals. The SwoleCharts
market directory matched 521 of those contracts at capture time. Historical
coverage can differ from the directory, so the backtest checks each window.
[SwoleCharts API documentation](https://swolecharts.com/developers)

The seven-day amount figures above apply to that earlier profile. An earlier
alert score was fitted on the first four days of the November 12–19 replay
using five contracts. On the last three days across six contracts, including
BTC, mean average precision by contract, direction and day rose from 16.8%
to 20.9%. Using the same conservative price confirmation, the previous score
confirmed zero alerts and the fitted score confirmed 29, of which 24 fell
in a Swolecharts event interval. This covered 24 of 891 recorded event intervals.

Token details read supply limits, locked balances, and future releases from
`lib/coin-unlock-snapshot.json`. The importer matches sources to perpetual
contracts using CoinGecko's contract identities. It combines CoinMarketCap
with reviewed project data, including Binance Research supply figures and
reviewed public schedules for INIT, ARB, and AGT. Binance's spot unlock calendar republishes
CoinMarketCap data, so it counts as the same source.
Verified mappings in `lib/coin-source-aliases.json` link CoinGecko IDs to their
CoinMarketCap slugs when they differ, such as `lombard-protocol` and `lombard`
for BARD. After updating the mappings, existing incomplete cache entries are
eligible for a fresh lookup immediately.
The API's `tokenomics` field includes up to three future releases, their
allocation breakdowns and supply percentages, and explicit coverage states.
If those releases contain no cliff unlock, `nextCliff` exposes the next
available cliff separately.
Percentages use maximum supply where available, otherwise the snapshot's
total supply. Events derived from cumulative vesting curves carry
`timeKind: "interval-estimate"` and `periodStart`, so consumers can distinguish
release intervals from dated scheduled events. The research page shows
the import time and hides expired events. It reads the bundled snapshot and
the per-contract files in `.cache/unlocks/` before requesting schedules.
Missing coverage, expired events, and incomplete allocations trigger a lookup
for that contract only. Complete records are also rechecked after 24 hours.
Mixed cliff and linear totals are split only when the provider's allocation
amounts account for the entire event. A locked amount above its supply basis
is displayed as unverified.
Successful and partial results are written atomically. If a source still
lacks information or is unavailable, the app keeps the saved data and waits
six hours before trying again. Live market prices use their own cache.

Bitcoin uses the protocol parameters in `lib/coin-issuance-rules.json` and a
saved Blockstream height to calculate block subsidy, estimated daily issuance,
and the next halving height and estimated date. These are issuance estimates,
not a fixed daily vesting schedule. Total market cap is estimated as current
price multiplied by maximum supply. Explicitly unlimited supply is labeled
unlimited; unknown supply limits remain unknown.
ETH's separately configured staking rules describe validator issuance and
base-fee burning, with no fixed halving schedule. Its variable daily issuance,
burn, and net issuance stay null until a verified daily snapshot is supplied.

Set `DEFILLAMA_API_KEY` (API plan) and/or `TOKENOMIST_API_KEY` (a plan with
future unlock coverage) to import live cliff unlocks from either provider.
Each source can fail independently. The importer compares dates by UTC day
and release type, prefers an amount supported by more providers within 1%,
and otherwise prefers DefiLlama, then Tokenomist, then CoinMarketCap.
The event details show the other amounts when comparable. Linear estimates
and cliff events use different release definitions and are never added
together. Reviewed public records apply only to the listed tokens.

To refresh the snapshot manually, run `node scripts/refresh-unlock-snapshot.mjs`
from `docs/playground` with curl available. If your network needs a proxy, set
`HTTPS_PROXY` in the shell first. Refresh after a displayed event passes to
import later events and update locked balances and the Bitcoin height.
The importer replaces the file after downloading and matching token details,
preserving previously saved records for individual sources that fail.
Restart the server if it does not pick up the new file.
Use `--missing-only` to fill missing token records or
`--contracts=BTCUSDT,SUIUSDT` to refresh selected contracts while preserving
the rest of the snapshot. Cross-source slug aliases live in
`lib/coin-source-aliases.json` and still require matching token symbols.

The token-details panel can fetch the largest 200 on-chain holder addresses
on demand. Each address's share and the combined share use the same total
market cap as the token details. The current price cancels out, so the share
is the holder's token balance divided by maximum supply. For coins with
unlimited supply, shares use circulating market cap and the panel labels
that basis. Coins whose supply limit is unknown still show balances.
Results identify the chain and
contract, since a single-chain address list is not a global holder census.
Exchange, custody, vesting, burn, and contract addresses remain included.
Unsupported chains and incomplete rankings are labeled explicitly.
Contract addresses can come from either verified CoinMarketCap or CoinGecko
metadata. A supported primary contract is preferred when CoinGecko identifies
one. An alternate verified chain can provide a single-chain snapshot when the
preferred source is unavailable. Blockscout also covers Polygon and Gnosis.
Successful snapshots are cached for six hours in memory and in the ignored
`.cache/holders/` directory. Native ETH uses Ethereum's address list.
XRP uses XRPSCAN's nightly list with balances including escrow. TRX uses
TRONSCAN's top accounts with total balances including staked/unstaking amounts.
BNB Smart Chain tokens use Binplorer's exact base-unit balances. The public
endpoint covers up to 100 holders and the panel labels that result as partial.
Set the server-side `BINPLORER_API_KEY` to a Binplorer personal key to request 200.
BTC uses CoinLore's free top-100 page, explicitly labeled as partial and
approximate because the displayed balances are rounded. The BTC snapshot
uses the same six-hour cache. Other native chains without a verified source
show a coverage message.

The perpetual market details show the latest settled funding rate, the
exchange's estimate for the upcoming settlement, and up to 12 previous
settlements. Strategies can reuse `getMarketFundingRates(pair)` or call
`GET /api/markets/funding-rates?exchange=binance&symbol=BTCUSDT`.
OKX uses its instrument ID, such as `BTC-USDT-SWAP`. `previous` is the first
entry in newest-first `history`. `next` is the upcoming estimate. Each
entry has a decimal `rate` (0.0001 means 0.01%) and millisecond `time`.
The server shares snapshots by exchange and contract for up to 30 seconds.

Perpetual order-book snapshots are available through
`GET /api/markets/order-book?exchange=binance&symbol=BTCUSDT`
or the corresponding OKX instrument ID. Price levels contain a USDT price
and base-asset quantity, including converted OKX contract quantities.
The market page refreshes depth about every five seconds, requesting up to
1,000 levels per side from Binance and 5,000 from OKX. The table shows the
first 1,000 levels per side in ten groups of 100 with each group's price
range and quoted notional.

The app refreshes the lists every 15 seconds and also reacts to Binance
futures `!contractInfo` notifications. Futures and spot show taker buy
and sell turnover. Alpha shows total turnover because its public trade
direction field is deprecated. The 5-second, 30-second, and 1-minute
windows refresh every second from live trades. The 5-minute, 1-hour,
24-hour, and 7-day windows refresh after each closed minute.
OKX shows taker buy and sell turnover from live trades for short windows.
Until live trades cover a full minute, the one-minute row shows the last
closed candle's quote turnover. Longer perpetual windows use OKX's completed
contract taker-volume periods and show each window's cutoff. Longer spot
windows fill in as the live stream covers each full window. Confirmed candle
totals are available while directional data is missing.

The perpetual turnover panel shows the selected exchange's volume multiple to
two decimal places. It divides the most recent completed UTC day's quote volume
by the mean of up to 180 preceding full trading days. The server caches a valid
multiple until the next UTC day.

Use the price monitor embedded in the market page to watch all listed Binance
USDT perpetual contracts. **异动监控**, **告警记录**, and **涨跌预测** start
collapsed on each page load. **告警记录** and **涨跌预测** can be expanded
independently inside the monitor. The **超阈值记录** navigation opens
the price-trigger history while monitoring continues. Monitoring starts off by default.
Confirm the prompt after switching the strategy on or off. Turning it off
closes the price stream and cancels pending checks.
In local mode, turn on **异动监控 → 启用策略** to launch an independent process
automatically. The process keeps monitoring after the browser or the local
web server is closed. Turn off the same switch to stop it. On the public
Playground, keep the market page open for browser-based monitoring.
Set the window in whole seconds (10 to 300, default 30)
and enable upward alerts, downward alerts, or both, with separate thresholds.
Both thresholds have a minimum magnitude of 2%. Downward thresholds must
be below 100%. Previously saved thresholds and windows outside these bounds
are adjusted when the settings are read.
Each direction maintains its own rolling samples and alert levels.
Changing the price thresholds or window restarts sampling. Existing signed
threshold settings migrate to the corresponding direction.
The local monitor uses the exchange's event timestamps. In browser mode, the
monitor samples the latest received price once per second. A rule triggers
when its signed percentage threshold is reached or exceeded.
Levels compound from the threshold price rather than the traded price.
For example, a 5% upward rule starting at 100 has levels at 105, 110.25,
and 115.7625. A sample can reach several levels and reports the highest one.
Each level reached starts a fresh window for the next level. If the window
expires, the monitor returns to looking for the start of a new series.

Price triggers appear in **超阈值记录**. The first trigger in each series
enters the turnover check queue. The configured window's Binance USDT
turnover must reach the configured multiple (default 3×) of the baseline
before any alert in that series is issued. Later levels share that check.
If the price advances while the check is pending, the highest level reached
is reported when the check passes. The baseline
is the median quote turnover of 60 complete one-minute candles before the
window starts, scaled to its duration. The page shows the latest 100 price
triggers and their check results. Data gaps or interrupted checks
remain visible in the history. Confirmed alerts appear in the strategy panel
and can also be sent to a DingTalk group robot.

On Windows, launch with `start-playground.cmd` and open **交易策略 → 钉钉推送**
on the local market page. Paste the group robot Webhook and, if signing is
enabled, its signing secret. Click **保存并启用**, then **发送测试消息** to check
delivery. On the local settings page, enter up to 500 characters of custom text
or leave the test message field blank to send the default. Then click
**异动监控 → 开启钉钉通知** to send confirmed alerts
from the monitor. Notifications start off by default.
**停止钉钉通知** stops sending while alerts continue to appear on the page.
Use **暂停推送** or **恢复推送** for the server-wide robot setting.
Existing `DINGTALK_WEBHOOK_URL` and
`DINGTALK_WEBHOOK_SECRET` values act as a fallback until a robot is saved on
the local page. To enable editing when starting the server manually, set `PLAYGROUND_LOCAL_SETTINGS=1`
and bind Next.js to `127.0.0.1`.
Server-side strategies can call `strategyNotifier.send({ title, lines })` from
`lib/strategy-notifications.ts`. Browser strategies add a typed event and a
server-side template in `lib/strategy-notification-events.ts`.

The local monitor stores its rule, price triggers, alerts and latest DingTalk
delivery attempts in `.cache/market-monitor/monitor.sqlite`. Both processes
use the same `PLAYGROUND_MONITOR_DB` override if set. An existing local
monitor rule takes precedence. The first local rule can reuse thresholds
and notification preferences previously saved by that browser.
The monitor starts a new price window after reconnecting, re-enabling, or
changing the rule.
Alerts include the level and Binance's latest available five-minute
all-account long/short ratio and top-trader position ratio at the trigger time.
The first trigger records the checked USDT turnover.

Failed or rate-limited deliveries retry at most twice. **异动监控 → 告警记录**
shows the outcome and last attempt for each alert. The worker retains 30 days
of history on disk. With Node.js 24, `node --run monitor` from
`docs/playground` also starts the worker in the foreground for diagnostics.

Open **历史强平回测** under the selected coin's Binance liquidation panel to
inspect the latest 24 hours in five-minute windows. Select a reference source
and direction to compare observed liquidation amounts with earlier risk
bands. Coverage gaps remain visible and are excluded from the false positive
rate, which uses covered windows below the observed event threshold.

On the docs deployment at `/playground`, press **Run** (or ⌘/Ctrl+Enter) to
execute a snippet. Switch languages with the tabs and load ready-made snippets
from **Examples…**.

## Deploy with Docker (recommended for any shared/public host)

Running user code directly on a host is unsafe (see **Sandboxing & safety**).
The Docker setup makes the **container the trust boundary** — user code can only
touch the container filesystem; the host is unreachable.

```bash
cd docs/playground
PLAYGROUND_AI_URL=http://<host>:<port>/v1/chat/completions docker compose up --build
# → http://localhost:3000
```

The image bundles every runtime (Node, Python, PHP, Go, .NET) with CCXT
pre-installed and the Go/C# build caches **warmed at build time**, so first runs
are fast. Pass `--build-arg PLAYGROUND_DISABLED=go` (and/or `csharp`) to keep a
compiled language **install-only** — an escape hatch for a small host where
compiling ccxt-go (~5 GB) would OOM. Pass `--build-arg NEXT_BASE_PATH=/playground`
to serve under a sub-path. `docker-compose.yml` enforces the host protections:

- **minimal bind mounts** → the only host paths mounted are the two append-only
  log dirs (`/var/log/ccxt-playground/{app,proxy}`); nothing else on the host
  filesystem is reachable. (A run shares the app container's fs, so it could write
  to the app log dir — bounded by logrotate below — but cannot escape it; the proxy
  log lives in the separate proxy container, out of a run's reach.)
- **`mem_limit` / `cpus` / `pids_limit` + `--init`** → a user can't exhaust host RAM/CPU, fork-bomb it, or orphan processes;
- **non-root + `no-new-privileges` + `cap_drop: ALL`** → minimal blast radius;
- **egress allowlist** → the app runs on an internet-less `internal` network. All
  outbound goes through the `egress-proxy` (squid) sidecar, which permits the
  exchange API domains generated from CCXT and HTTPS to the exact SwoleCharts,
  CoinBoss and CryptoHFTData liquidation API hosts (`proxy/`). Mining pools, C2,
  data-exfil endpoints, and the host's neighbor services are all unreachable —
  even via a raw socket, because the app has no other route out;
- **no inference credential in the container** — the app posts to the endpoint in
  `PLAYGROUND_AI_URL` (deployment-local, reached directly via `NO_PROXY`); that
  endpoint holds the credential, so a run that reads the server's env finds
  nothing worth stealing. Run children also get a scrubbed env;
- **submission logging** → every `/api/run` and `/api/ai` request is logged as
  JSONL (`lib/log.ts`) for abuse inspection. In production the deploy points
  `PLAYGROUND_LOG_FILE` at a host-mounted file (`/var/log/ccxt-playground/app/`)
  and bind-mounts the squid access log (`/var/log/ccxt-playground/proxy/`), so both
  the submitted code and every outbound exchange request survive container swaps and
  the nightly clean. A logrotate config (`/etc/ccxt-playground/logrotate.conf`,
  hourly cron) hard-caps each at `size 25M × rotate 4` (compressed) so logs can't
  fill the disk; each container's Docker stdout json log is capped via `--log-opt`;
- **daily clean** → the deploy installs a cron that restarts the container nightly
  to wipe any in-container state (runs are already killed at their timeout).

### Egress allowlist — how it stays "exchanges only"
`proxy/generate-allowlist.mjs` instantiates every CCXT exchange and extracts the
hostnames from each `exchange.urls.api`/`urls.test`, producing the squid
`dstdomain` allowlist at proxy-build time. So the permitted set is exactly the
exchange API hosts for the bundled CCXT version (currently ~250 rules). The
production canary smoke test makes real exchange calls *through* the proxy, so a
mis-generated allowlist that blocked exchanges would fail the smoke and abort the
deploy — the egress path is verified on every release.

Code from different users *can* see each other inside the container — that's an
accepted trade-off; the boundary is host-vs-container, not run-vs-run. Note this
also means a run can read the server process's env via `/proc` inside the
container — which is precisely why no inference credential lives there; the
assistant's credential stays behind `PLAYGROUND_AI_URL`.

Verified: from inside the container a run **cannot** read or write host files
(the host `.env.local` doesn't exist there, writes to host paths fail), sees only
the container's `/etc/hosts` and a non-root `/home/playground`, and a crash
(even a hard `SIGILL`) leaves the server healthy.

> **Build on the target architecture.** CCXT's Python wheels crash (`SIGILL`) under
> Docker Desktop on Apple Silicon (arm64) — Python is skipped there and the build
> continues. On a normal **amd64 Linux server** (or native arm64 hardware) all
> runtimes work; build there, or `docker build --platform linux/amd64`.

## Production: docs.ccxt.com/playground

Live deploy is automated by [`.github/workflows/deploy-playground.yml`](../../.github/workflows/deploy-playground.yml)
(modeled on the Fumadocs workflow, same box + secrets). On push to `master` under
`docs/playground/**` (or manual dispatch) it: builds the amd64 image on a native
runner → pushes to `ghcr.io/ccxt/ccxt-playground` → SSHes to the docs box →
runs a **canary** on a temp port → smoke-tests (homepage + a real `6*7→42` TypeScript
run) → promotes to the live container only if green (else leaves the old one up).

It's served behind the existing nginx as `location /playground` → the app's
**static IP on the internal network** (`http://172.31.0.10:3000`), alongside the
Fumadocs site at `/`. (Publishing a host port doesn't work on a Docker
`internal` network, but the host can route *into* it — so nginx targets the
container's fixed internal IP, and the container still has no route *out* except
via the egress proxy.)

**All six runnable languages (TypeScript/Python/PHP/Go/C#/Java) run in production.**
The Go warm build (~5 GB peak) happens on the GitHub-hosted build runner, not on
the docs box; the run container's 3 GB cap covers warm `go run`s plus concurrent
Java JVMs (`-Xmx512m` each). On a small box, add `PLAYGROUND_DISABLED=go,java`
to the workflow's build-args to make them install-only again.

One-time box setup (already done on the current box):

- `/root/ccxt-playground.env` (root-only) holding `PLAYGROUND_AI_URL=...`
- the nginx `location /playground` + rate-limited `location /playground/api` block
- GitHub repo secrets reused from the Fumadocs deploy: `DOCS_DEPLOY_SSH_KEY`,
  `DOCS_DEPLOY_KNOWN_HOSTS`, `DOCS_DEPLOY_HOST`, `DOCS_DEPLOY_USER`.

The deploy puts the app on the internal network behind the egress proxy and
installs the nightly-restart cron automatically.

## Runtimes

`npm run setup-runtimes` provisions isolated, pinned CCXT installs:

- **TypeScript** uses the playground's own `node_modules/ccxt` (run natively by Node — nothing extra).
- **Python** → `runtime/python/.venv` (`pip install ccxt`)
- **PHP** → `runtime/php/vendor` (`composer require ccxt/ccxt`)
- **Go** → `runtime/go` module (`go get github.com/ccxt/ccxt/go/v4`) with its build
  cache **pre-warmed** (cold build of ccxt is ~45s; warm runs ~2s). Needs Go 1.24+.
- **C#** → `runtime/csharp/app` project (`dotnet add package ccxt`) restored and
  build-warmed. Needs the .NET SDK.
- **Java** → `runtime/java/libs` (`io.github.ccxt:ccxt` + transitive jars resolved
  from Maven Central; latest release unless `CCXT_JAVA_VERSION` is pinned) plus a
  precompiled `Playground` proxy helper in `runtime/java/classes`. Needs JDK 21+
  and Maven at provision time (Docker resolves the jars in a throwaway build
  stage, so Maven never ships in the image).

Python and PHP fall back to the surrounding monorepo's CCXT (`../../python` via
`PYTHONPATH`, `../../ccxt.php`) if not provisioned. Go, C# and Java show a "run
setup-runtimes" message until provisioned (no fallback — they need the warm
cache/restore/resolved jars to be fast).

## Sandboxing & safety

User code runs in `lib/runners/sandbox.ts` with:

- **scrubbed env** — the child process only sees `PATH`/`HOME`/`LANG`, never the
  server's secrets;
- **hard timeout** — the whole process group is `SIGKILL`ed after
  `RUN_TIMEOUT_MS` (default 15s);
- **output cap** — combined stdout/stderr is bounded (256 KB);
- **throwaway cwd** — each run gets a temp dir that is deleted afterwards.

Those bound a runaway loop, but they do **not** sandbox the filesystem, memory,
or network: code run directly on the host can read/write any file the server
user can (including secrets), allocate until OOM, and make arbitrary network
calls. So **running `npm run dev` directly is for local, trusted use only.**

For anything shared or public, use the **Docker deployment above** — the
container is the boundary (no host mounts, mem/cpu/pids limits, non-root). Still
recommended on top:

1. Put `/api/run` behind rate limiting and a per-IP concurrency cap.
2. Restrict the container's outbound network to exchange hosts if you want to be strict.
3. For untrusted multi-tenant use where runs must not see each other, run each
   execution in its own throwaway container (or gVisor) rather than the shared one.

## How Java runs (and how it reaches exchanges)

Java runs server-side like Go/C# (`lib/runners/java.ts`): each run is compiled
in a throwaway dir (the snippet must be `public class Main`) and launched
against the pre-resolved `runtime/java/libs/*` classpath. Runs go through a
generated `Launcher` that calls `Main.main` and then forces JVM exit —
ccxt-java's pro `close()` leaves Netty's shared event loop alive, so a `watch*`
snippet's JVM would otherwise linger until the hard timeout after `main`
returns.

One wrinkle the other languages don't have: **ccxt-java ignores proxy env
vars** (`System.getenv` never appears in `io/github/ccxt/**`), and its REST
client (`java.net.http.HttpClient`) defaults to *no* proxy. The runner therefore
parses `HTTPS_PROXY`/`HTTP_PROXY` into JVM flags
(`-Dhttps.proxyHost/-Dhttps.proxyPort/-Dhttp.*`), which `HttpClient` honors.
WebSockets are a separate path: ccxt's Netty `WsClient` ignores those flags and
only reads the exchange's own `wssProxy` field, so `watch*` snippets construct
exchanges via `Playground.proxy(new Binance())` — a tiny helper precompiled
into `runtime/java/classes` that sets `httpsProxy` + `wssProxy` from the env
(no-op outside the playground).

## Layout

```
app/
  page.tsx              playground shell (state lives here)
  api/run/route.ts      POST {language, code} -> execution result
  api/ai/route.ts       POST {messages, language, code} -> streamed completion
components/             Toolbar, Editor (Monaco), OutputPanel, AssistantPanel
lib/
  languages.ts          language metadata
  examples.ts           starter snippets per (example, language)
  runners/              sandbox + ts/python/php runners + dispatcher
  ai/assistant.ts       endpoint config + system prompt
scripts/setup-runtimes.sh
```
