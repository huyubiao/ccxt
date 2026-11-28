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

On Windows, double-click `start-playground.cmd` at the repository root. It
requires Node.js 24 or later with npm for the first dependency installation.
You can also extract the Windows Node.js ZIP so that `node.exe` and
`node_modules/npm` are directly under `docs/playground/runtime/node`.
When the server is ready, open <http://127.0.0.1:3000/>. Use
`start-playground.cmd 3001` for a different web port. The older `rust` argument
also starts the Rust service.

### Rust market backend

On Windows x64 the launcher first looks for
`docs/playground/market-service/bin/win32-x64/playground-market-service.exe`.
The release executable embeds its Rust and C runtime dependencies. A matching
binary also works with the `monitor` command. A source checkout automatically
builds the backend when the executable is missing or its Rust sources or bundled
data snapshots are newer. This uses a current stable Rust toolchain and Windows
C/C++ build tools. Set `PLAYGROUND_BUILD_RUST=1` before launching to force the
source build. When the workspace toolchain and Cargo cache are installed under
`tmp/playground-rustup` and `tmp/playground-cargo`, the Windows launcher uses
them. Set `RUSTUP_TOOLCHAIN` to select a different installed toolchain.

To produce a Windows x64 release from the repository root with PowerShell:

```powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = "-C target-feature=+crt-static"
cargo build --release --locked --target x86_64-pc-windows-msvc --manifest-path docs/playground/market-service/Cargo.toml
New-Item -ItemType Directory -Force docs/playground/market-service/bin/win32-x64 | Out-Null
Copy-Item docs/playground/market-service/target/x86_64-pc-windows-msvc/release/playground-market-service.exe docs/playground/market-service/bin/win32-x64/
```

The launcher assigns Rust an available loopback port and passes its address
and a fresh internal token to Next.js. It reuses existing SQLite monitoring
records and DingTalk settings. Stop any monitor from an earlier version before
starting the Rust service against the same database.

You can also run the services separately from `docs/playground`. Set
`PLAYGROUND_LOCAL_SETTINGS=1` and the same `PLAYGROUND_MARKET_SERVICE_TOKEN`
for both processes. Generate the token with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
and keep it in the server environment. Run
`cargo run --locked --manifest-path market-service/Cargo.toml` in one terminal.
In the other, set `PLAYGROUND_MARKET_SERVICE_URL=http://127.0.0.1:3101` and run
`npm run dev -- --hostname 127.0.0.1`. If Node uses an HTTP proxy, include
`127.0.0.1` in its `NO_PROXY` list. The Rust service reads `HTTPS_PROXY`,
`PLAYGROUND_MONITOR_DB`, and DingTalk environment values from its own process.
The live Binance stream supports direct TLS and unauthenticated HTTP CONNECT
proxies, including the Windows system proxy used by the launcher.

Next.js forwards market API requests and strategy notifications to Rust. The
Rust service handles market directories,
quotes, order books, funding, volume, alert context, liquidation risk, market
caps, token fundamentals, holder research, and the background strategy monitor.
The Binance USDⓈ-M REST requests use the repository's CCXT Rust SDK. The
background monitor reads the original public mini-ticker frames over Tokio.
Market APIs return HTTP 503 when the Rust service is unavailable or its URL
is missing. Next.js serves the browser interface and multi-language code
runner.

In development, source changes are applied by Fast Refresh. Development
uses `.next-dev` and production builds use `.next`, so running a production
build does not overwrite assets served by the development server.

```bash
cd docs/playground
npm install
npm run setup-runtimes        # optional but recommended (see below)
cp .env.example .env.local    # set PLAYGROUND_AI_URL for the AI panel
node scripts/start-rust-markets.mjs  # http://127.0.0.1:3000
```

The local homepage lists crypto assets with an active USDT-margined perpetual
contract on Binance. Binance and OKX market directories use exchange metadata to
exclude stock, index, commodity, and other non-crypto markets. Select a coin and
switch platforms to view its USDT-quoted pairs across Binance and OKX. The USDT filter also
applies to Binance Alpha. Markets with multiple pairs offer a pair selector.
Alpha pairs are grouped by coin symbol and include their Binance ID and,
when available, their chain and token address to distinguish same-name tokens.

The price movement monitor stores its DingTalk notification preference separately
from price monitoring. The monitor watches the Binance USDT perpetual crypto
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

Research shows the Binance long/short liquidation risk chart. The snapshot
API at GET /api/markets/liquidations?symbol=JCTUSDT returns price bands and
their openInterestShare and riskLevel. The chart grades modeled position
concentration if the mark price reaches each band. It exposes the price
bounds, direction, mark price and snapshot coverage. The API also retains
the modeled band notional fields for strategy calculations.

Live estimates allocate new positions across 1x, 2x,
3x, 4x, 5x, 7x, 10x, 20x, and 50x. They read the Binance public leverage
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

The earlier `binance-swolecharts-2026-11-19` profile used tiers up to 100x.
Its calibration fitted 47 contracts using the seven days
ending November 12 at 11:00 UTC. The following seven days were held out.
On 82 contracts with comparable observations, the median absolute percentage
error of the seven-day total fell from 85.5% to 64.0%. The new estimate was
closer for 65 contracts. The pooled total moved from 3.0% below the reference
to 12.7% above it. For the 35 contracts excluded from training, the median
error fell from 86.0% to 67.6%. Weight normalization and leverage ceilings
were verified for the 764 active Binance USDT perpetuals. The SwoleCharts
market directory matched 521 of those contracts at capture time.
[SwoleCharts API documentation](https://swolecharts.com/developers)

The seven-day amount figures above apply to that earlier profile. An earlier
alert score was fitted on the first four days of the November 12–19 replay
using five contracts. On the last three days across six contracts, including
BTC, mean average precision by contract, direction and day rose from 16.8%
to 20.9%. Using the same conservative price confirmation, the previous score
confirmed zero alerts and the fitted score confirmed 29, of which 24 fell
in a Swolecharts event interval. This covered 24 of 891 recorded event intervals.

Token details read supply limits, locked balances, and release records from
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
available cliff separately. `recentUnlocks` lists up to two past releases
in reverse chronological order, with the same allocation and percentage fields.
The page shows their allocation details and valuations at the current price.
Percentages use maximum supply where available, otherwise the snapshot's
total supply. Events derived from cumulative vesting curves carry
`timeKind: "interval-estimate"` and `periodStart`, so consumers can distinguish
release intervals from dated scheduled events. Completed intervals are dated
by their end time. Past scheduled events reflect source schedules. The page shows
the import time and keeps recent releases from earlier snapshots.
It reads the bundled snapshot and
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
USDT perpetual contracts. **账号设置**, **异动监控策略**, **告警记录**,
**测试策略**, and **下单记录** start collapsed and each remembers its last
expanded or collapsed state in the same browser. Monitoring starts off by default.
Confirm the prompt after switching the strategy on or off. Turning it off
closes the price stream and cancels pending checks.
On Windows, run `start-playground.cmd` and open the local market page. Use
**异动监控策略 → 启用策略** to start or stop monitoring. The Rust backend
saves that choice and monitors with the same rule after the webpage or browser
closes, as long as the launcher is running. When you reopen the page, it shows
the saved state. A later launch also reads the saved rule. On the public
Playground, keep the market page open for browser-based monitoring.

The **交易策略 → 运行状态** panel polls the Rust health endpoint and shows its
last successful response. The monitor shows **运行中 · 后台** after the worker
reports a fresh quote for a monitored contract. To configure automatic orders,
open **异动监控策略 → 自动下单**. The test strategy runs on manual request. If the
web page loses contact with Rust, it reports the backend strategy status as
unknown until it can read it again.

Set the window in whole seconds (10 to 300, default 30)
and enable upward alerts, downward alerts, or both, with separate thresholds.
New rules start with both directions selected at 5%.
Both thresholds range from 2% through 100%, inclusive. Previously saved
thresholds and windows outside their bounds are adjusted when the settings
are read.
The short window is used to detect the first trigger. An upward trigger compares
with the lowest price in that window, and a downward trigger with the highest.
If both directions qualify on a sample, the monitor considers the direction of
the latest price change first. Existing signed thresholds keep their direction.
The local monitor uses the exchange's event timestamps. In browser mode, the
monitor samples the latest received price once per second. A rule triggers
when its signed percentage threshold is reached or exceeded.
The first price trigger fixes the original reference price and direction for
that symbol. The observation period starts when the first alert is confirmed.
The observation duration is
configurable in whole minutes and defaults to 15. The separate upward and
downward observation steps both default to 3%. Levels compound from the
original reference using the step for the first trigger's direction. With a
reference of 100, an initial threshold of 5%, and an observation step of 3%, the
upward levels are 105, 106.09, and 109.2727. Bands already crossed at the first
trigger count as reached. A sample can cross multiple new bands and reports the
highest one. Each upgrade restarts the full observation period from the price
triggering it. For a 15-minute period, a first alert confirmed at 10:00 and an upgrade
at 10:10 move the deadline to 10:25.
An upward series ends when price reaches or drops below the original reference,
and a downward series ends when it reaches or rises above it. On return or
expiry, the current sample starts a new short window for both directions.

Price triggers appear in **告警记录**. The first trigger in each series
enters the turnover check queue. The configured window's Binance USDT
turnover must reach the configured multiple (2× through 100×, default 3×) of the baseline
before any alert in that series is issued. Later levels share that check.
Previously saved multiples outside this range are adjusted when read.
The form sets out-of-range numeric thresholds and turnover multiples to the
nearest limit when leaving the field or saving the settings.
The first alert reports the level of its initial price trigger. The monitor
checks for upgrades using quotes from the observation period. A failed or
interrupted turnover check returns the symbol to short-window monitoring.
A retracement on the same side of the reference keeps
the round open, even when it would qualify as a short-window trigger in the
opposite direction. The baseline
is the median quote turnover of 60 complete one-minute candles before the
window starts, scaled to its duration. The page shows the latest 100 price
triggers and their check results, including queued, unsuccessful, and
interrupted checks. In **告警记录**, check individual rows or use **全选** in
the table header to select all currently displayed rows. Choose **删除选中记录**
to remove them from the table. In local monitor mode, older retained records
fill the available slots. Browser mode keeps up to 100 triggers locally.
The daily change compares the trigger price with the
opening price of that Beijing calendar day. Confirmed alerts can also be
sent to a DingTalk group robot.

Both **告警记录** and the DingTalk message show the turnover multiple and
the baseline-to-window turnover in units of 10,000 USDT, for example
`成交额3.25倍(12万 -> 39万)`. Upgrades show the turnover comparison from
the first checked window of the same series.

On Windows, launch with `start-playground.cmd` and open **交易策略 → 钉钉推送**
on the local market page. Paste the group robot Webhook and, if signing is
enabled, its signing secret. Click **保存并启用**, then **发送测试消息** to check
delivery. On the local settings page, enter up to 500 characters of custom text
or leave the test message field blank to send the default. Then click
**异动监控策略 → 开启钉钉通知** to send confirmed alerts
from the monitor. Notifications start off by default.
**停止钉钉通知** stops sending while alerts continue to appear on the page.
Use **暂停推送** or **恢复推送** for the server-wide robot setting.
Existing `DINGTALK_WEBHOOK_URL` and
`DINGTALK_WEBHOOK_SECRET` values act as a fallback until a robot is saved on
the local page. To enable editing when starting the server manually, set `PLAYGROUND_LOCAL_SETTINGS=1`
and bind Next.js to `127.0.0.1`. Browser requests to send notifications
also require local settings mode.
Templates, delivery, and Webhook signing are implemented in the Rust service.
The browser submits typed events using `lib/strategy-notification-events.ts`.

The local monitor stores its rule, price triggers, alerts and latest DingTalk
delivery attempts in `.cache/market-monitor/monitor.sqlite`. Set
`PLAYGROUND_MONITOR_DB` to use another database file. An existing local
monitor rule takes precedence. The first local rule can reuse thresholds
and notification preferences previously saved by that browser.
Reconnects retain confirmed series and rebuild short windows for new triggers.
Re-enabling the monitor or changing its price or turnover settings starts fresh.
Alerts include the level and Binance's latest available five-minute
all-account long/short ratio and top-trader position ratio at the trigger time.

Failed or rate-limited deliveries retry at most twice. The worker retains 30 days
of history on disk.

### 下单执行与测试策略

策略产出一个 `OrderIntent`（下单意图：合约、方向、
USDT 金额或交易所最小下单量、杠杆、止损 %、止盈 %、可选限价平仓偏移、最长持仓时间），交给
`market-service/src/trading.rs` 里的统一执行层处理：

1. 检查风控上限，设置杠杆，市价开仓。
2. 立刻在币安挂好止损和止盈条件单（按标记价格触发）。这样即使本服务停止，
   交易所仍可执行保护单。如果止损或止盈单被拒绝，服务会尝试市价平仓。
   异动策略还会自动按剩余仓位挂限价平仓单。限价单待核对或暂时提交失败时，后台会在到期前核对并重试。
3. 每 5 秒检查一次进行中的交易：
   - 仓位已平时，核对平仓成交并撤销剩余的限价单和条件单。
   - 保护单已触发且只成交了一部分时，撤销限价平仓单并市价平掉剩余仓位。
   - 持仓到期时，撤销未完成的限价单，再对剩余仓位市价平仓。

本地异动监控每轮首次确认告警后评估开仓，后续升级告警记录独立评分。走势评估使用触发后 5 秒的聚合成交，主动成交使用完整告警区间。三项基础满分 100 分，成交额作为额外加分。

- **走势评估 35 分**。门槛价使用本条告警的实际触发价，参考价使用本条告警记录里的参考价。
  从触发后的下一毫秒开始观察 5 秒，上涨看最低成交价，下跌看最高成交价，并结合最后一笔成交价按以下顺序判定，取符合条件的最高档。
  - **突破后站稳，35 分**。上涨时全程不低于门槛价；下跌时全程不高于门槛价。
  - **回吐后收复，30 分**。中途退回门槛另一侧，最后一笔重新回到门槛或突破侧。
  - **回吐未失守，20 分**。最后一笔退回门槛内，但仍保留至少四分之三的突破幅度。
  - **回吐一半，15 分**。最后一笔保留至少一半、不到四分之三的突破幅度。
  - **回吐即将失守，5 分**。最后一笔仍在参考价的突破侧，但保留幅度不到一半。
  - **失守，0 分**。最后一笔回到或越过参考价，跳过下单。恰好等于参考价也计 0 分。
  四分之三界线为 `参考价 + (门槛价 - 参考价) × 3/4`，一半界线为 `(门槛价 + 参考价) / 2`，等于界线归入较高档。
  例如上涨参考价为 100、门槛价为 110，最后一笔在 107.5 至 110 之间得 20 分，在 105 至 107.5 之间得 15 分，
  在 100 至 105 之间得 5 分；各区间包含下界但不含上界，100 本身计 0 分。下跌时按相反方向比较。
  告警详情同时展示门槛价、参考价、最不利成交价和最后成交价，历史记录保留当时的评分。
- **同向主动成交 + 订单簿深度 35 分**。主动成交以 USDT 成交金额计算占比，上涨取主动买入占比，下跌取主动卖出占比。
  首次告警统计“参考价最后一次出现”到“告警触发”之间的成交。后续每次升级，统计“上一次告警”到“本次告警”之间的成交。
  跳级时以实际上一条告警为起点。完整分钟使用 K 线的成交额与主动买入金额，首尾不足一分钟的部分使用聚合成交。
  同向占比四舍五入到两位小数，达到 55%、60%、65%、70%、75% 分别得 10、15、20、30、35 分，低于 55% 得 0 分。
  订单簿在告警确认后立即发起请求，获取买卖两侧各最多 1000 档深度快照，逐档按价格乘数量汇总 USDT 挂单金额，实际快照时间见告警详情。
  上涨取买盘金额除以买卖盘总金额，下跌取卖盘金额除以买卖盘总金额。
  挂单占比四舍五入到两位小数，达到 60%、65%、70%、75%、80% 及以上分别补充 5、10、15、20、25 分，低于 60% 得 0 分。
  两项相加封顶 35 分。深度快照缺失、过期或无效时补充 0 分；完整区间成交不可用时跳过下单。
  告警详情展示区间起止、主动买卖金额、同向占比、深度快照时间、买卖盘档数和金额，以及两项分数。
  历史记录按其保存的原评分展示。盘口采用告警确认后请求的快照，历史成交回放需要另有对应时刻的深度数据才能补算。
- **异动前横盘平静度 30 分**。本轮首次告警计算一次并保存，后续升级沿用首报的区间、指标和分数。历史数据不足或请求失败计 0 分，同轮沿用这一结果。
  回看首报异动窗口开始之前的 X 小时，默认 24 小时，仅使用已结束且连续完整的 1 分钟 K 线。
  - 整体振幅为（最高价 − 最低价）÷ 最低价 × 100%。不超过 5% 得 10 分，超过 5% 且不超过 8% 得 5 分，超过 8% 得 0 分。
  - 前后偏移为 |后半段平均收盘价 ÷ 前半段平均收盘价 − 1| × 100%。不超过 1% 得 10 分，超过 1% 且不超过 2% 得 5 分，超过 2% 得 0 分。
  - 最大单根振幅为各根（最高价 − 最低价）÷ 开盘价 × 100% 的最大值。不超过 1% 得 10 分，超过 1% 且不超过 2% 得 5 分，超过 2% 得 0 分。
  各项直接按原始数值评分，界线包含等号。方向偏移取绝对值，上涨和下跌按同一标准评分。
- **告警成交额额外加分，最多 20 分**。首次告警的成交额倍数严格超过 100、200、400、700、1000 倍，分别加 3、5、10、15、20 分。
  升级时使用上一次告警之后至本次触发的实际区间成交额，除以上一次告警的成交额。严格超过 5、10、20、50、100 倍，分别加 3、5、10、15、20 分。
  第一次升级的分母为首报成交额核验窗口的金额，后续分母为上一条升级区间的实际成交额。跳级按实际上一条告警比较。分母为 0 或数据不可用时加 0 分。
  取满足条件的最高一档，恰好等于门槛归入较低档。金额与区间长度一起展示，便于比较放量情况。

走势评估 35 分、同向主动成交与深度 35 分、横盘平静度 30 分，基础满分 100 分，加成交额奖励最高 120 分。
连接币安账号并开启 **自动下单** 后，总分至少 80 分的告警可触发 1 倍杠杆市价开仓，上涨做多、下跌做空。
市价数量按账户所在交易环境的最低名义金额、最小数量、数量步长及标记价计算，仍受单笔金额和持仓上限约束。
在 **自动下单** 可设置新开仓的止损和止盈百分比，默认各 1%。清空输入框后，离开输入框或保存时会恢复该项默认值。
成交后以实际开仓均价为基准，在止盈距离的 75% 处自动挂限价平多或平空，默认距离为 0.75%。止盈条件单留在更远的盈利方向，
价格按币安合约的步长校准。挂单和保护单由后台自动处理，最长持仓 5 分钟。
自动下单默认关闭。登录或登出后需要重新开启。
5 秒窗口无成交或观察数据不可用时跳过下单。从该轮初次触发起超过 45 秒的信号不再开仓。
同一轮升级的主动成交和成交额奖励按实际告警区间重新计算，横盘平静度沿用首报结果。开仓使用首次确认告警，升级评分用于观察，后续补仓需要独立的下单信号。展开 **告警记录 → 延续评分与下单** 可查看买卖占比、
突破状态、评分和下单结果。强平估算可在 **币种深度调研** 查看。**下单记录** 展示测试策略和异动监控策略的交易。

执行层按异动轮次、下单信号和目标交易处理补仓。策略提供累计持仓上限，每笔补仓仍受单笔金额上限约束。
成交存入原交易，订单详情显示 **补仓**。交易继续沿用原止损、止盈和到期时间，原限价平仓单的数量继续按该挂单执行。
当前自动策略发出首次开仓信号，补仓的信号条件待定义。

当前账户进行中的交易可使用 **市价平仓** 按钮。
持仓中的交易可打开 **管理持仓**，输入限价提交 **限价平多** 或 **限价平空**，数量取币安当前的剩余策略仓位。
同笔持仓可有一张限价平仓单，页面显示部分成交数量，并可撤销剩余挂单。
止损和止盈可按 USDT 触发价分别调整。多仓止损须低于标记价，止盈须高于标记价，空仓方向相反。
条件单由币安按标记价触发，平掉对应方向的剩余仓位，包含已部分成交的限价平仓场景。
替换条件单时，系统确认新单后撤销旧单。修改两项时，每次获交易所确认的修改立即保存。
在 **下单记录** 可搜索交易对、按状态和账户筛选，结果每页显示 10 条。
点击 **详情** 可查看策略、止损止盈、开仓和平仓手续费及订单明细。
可勾选单条记录，或跨页全选符合筛选条件的已结束记录后删除。更改筛选条件会清除勾选。
开仓中、持仓中和平仓中的记录会保留。删除只作用于本地交易记录。
下单记录按币安返回的实际成交数量和成交额显示开、平仓均价及净盈亏。
两侧手续费分别按普通用户 Taker 费率 0.05% 估算，净盈亏不计资金费。
止损止盈触发后按实际订单查询成交，缺少可核实成交数据时显示空值。

本机页面的 **交易策略 → 账号设置** 集中配置钉钉机器人和币安账户。
币安账户只提供模拟盘和实盘登录。登录时核对 API Key 和双向持仓设置；
已登录时须先登出才能登录其他账号。有进行中的策略交易时须先结束交易才能登出。
凭据以本机 JSON 文件保存，默认路径为 `.cache/market-monitor/monitor.binance-account.json`
（相对于 `docs/playground`），自定义数据库时会随数据库路径变化。页面不回读凭据。
文件内容未加密，Unix 下新文件权限为 `0600`，Windows 使用目录的文件访问权限。
登出会用无凭据的状态替换该文件。仅当该文件不存在时使用以下环境变量作为后备配置：

| 取值 | 含义 | 需要的环境变量 |
| --- | --- | --- |
| `off`（默认） | 不下单 | 无 |
| `demo` | 币安模拟盘 Demo Trading（`demo-fapi.binance.com`） | `BINANCE_DEMO_API_KEY`、`BINANCE_DEMO_API_SECRET`（在 demo.binance.com 创建） |
| `live` | 币安实盘 | `BINANCE_API_KEY`、`BINANCE_API_SECRET`，以及 `PLAYGROUND_LIVE_TRADING_CONFIRM=YES_I_UNDERSTAND_REAL_MONEY` |

默认风控上限：单笔金额模拟盘 200 USDT、实盘 20 USDT，同时最多 3 笔交易，
杠杆不超过 5 倍，可在 `.env.example` 中查看并修改。止损幅度必须小于约
`80% × 1 / 杠杆`，确保止损在强平之前触发。其他限制：

- 币安 USDⓈ-M 账户的持仓模式须为双向。旧单向策略仓位继续按原模式管理；
- 同一个合约允许同时管理一个多仓和一个空仓。两侧共用杠杆；
- 同方向已有策略交易、交易所仓位或未成交订单时，拒绝该方向的新单；
- 只能在本地模式（`start-rust-markets.mjs` 启动）下单，和后台监控使用同一个服务器令牌保护。

**交易策略 → 测试策略** 用来验证整条下单链路。选择合约、做多或做空，
填写金额、杠杆、止损、止盈和持仓分钟数。

新增策略时参照 `market-service/src/test_strategy.rs`：读取行情或调研指标 →
返回一个 `OrderIntent` → 调用 `Trader::submit`。

#### 本次改动的文件

整体链路：页面 → Next.js 转发（带服务器令牌）→ Rust 服务 → 统一执行层 → 币安。

**Rust 后端（`market-service/src/`）**

| 文件 | 改动 | 作用 |
| --- | --- | --- |
| `trading.rs` | 新增 | 统一执行与风控。读取账户模式和风控上限；`OrderIntent` 下单意图；`Trader::submit` 负责风控检查 → 设杠杆 → 市价开仓 → 挂止损/止盈条件单；`Trader::check` 每 5 秒检查触发和到期；`Trader::close` 手动平仓。使用单独的交易客户端，不和行情请求抢同一把锁 |
| `test_strategy.rs` | 新增 | 把交易表单中的做多、做空和交易参数转成 `OrderIntent` |
| `store.sql` | 修改 | 新增 `trade` 表，保存每笔交易及其全部订单（JSON） |
| `store.rs` | 修改 | 新增 `save_trade`、`active_trades`、`trade`、`recent_trades` |
| `routes.rs` | 修改 | 交易状态、账号设置、测试下单和平仓接口都需要服务器令牌 |
| `main.rs` | 修改 | 启动时创建 `Trader`，打印下单模式，后台运行检查循环 |

**前端（Next.js）**

| 文件 | 改动 | 作用 |
| --- | --- | --- |
| `app/api/trading/route.ts`、`test-order/route.ts`、`close/route.ts` | 新增 | 转发到 Rust 服务；只接受本地模式、同源、JSON 请求 |
| `lib/trading-request.ts` | 新增 | 下单和平仓请求的公共检查与转发 |
| `lib/trading-types.ts` | 新增 | 交易、订单、账户状态的类型定义，以及盈亏估算 |
| `lib/market-service-proxy.ts` | 修改 | 下单相关路由加入需要令牌的白名单 |
| `app/markets/use-trading.ts` | 新增 | 每 4 秒读取下单状态；提供下单、平仓方法 |
| `app/markets/test-strategy.tsx` | 新增 | 「测试策略」面板：账户模式标签、余额、风控上限、下单表单和二次确认 |
| `app/markets/trade-records.tsx` | 新增 | 「下单记录」表格：状态、止损止盈、订单明细、盈亏、市价平仓按钮 |
| `app/markets/binance-settings.tsx` | 新增 | 在本机账号设置中连接模拟盘或实盘 |
| `app/markets/market-monitor.tsx` | 修改 | 交易策略区域挂上测试策略面板和下单记录 |
| `app/markets/markets.module.css` | 修改 | 模拟盘/实盘标签、下拉框、平仓按钮样式 |

**配置与文档**：`.env.example` 增加下单相关环境变量说明；本 README 增加本节。

#### 运行环境

- Node.js 24（项目使用 `URL.parse` 等新接口，Node 20 下下单请求会失败）。用 nvm 时先执行 `nvm use 24`。
- Rust stable。macOS 用 Homebrew 安装 rustup 后，需要把 `/opt/homebrew/opt/rustup/bin` 加入 `PATH`。
- 首次启动会自动编译 Rust 服务，之后启动只需几秒。

#### 配置模拟盘

1. 登录 [demo.binance.com](https://demo.binance.com)，在 API 管理中创建模拟盘 API Key。模拟盘 Key 和实盘 Key 是分开的。
2. 在模拟盘 USDⓈ-M 合约设置里，把「持仓模式」设为 **双向持仓**。
3. 启动（Windows 可直接运行仓库根目录的 `start-playground.cmd`）：

   ```bash
   cd docs/playground
   nvm use 24
   export PATH=/opt/homebrew/opt/rustup/bin:$PATH
   node scripts/start-rust-markets.mjs
   ```

4. 在本机 **交易策略 → 账号设置 → 币安账号** 选择「模拟盘」，填 Key 和 Secret 后点击 **登录**。

#### 测试方法

**第 1 步：离线测试（不需要 API Key）**

在仓库根目录执行：

```bash
(cd docs/playground/market-service && cargo test --locked)   # Rust 单元测试
(cd docs/playground && npx tsc --noEmit -p .)                 # 前端类型检查
```

`trading.rs` 中的测试覆盖：未配置模式或 Key 时不下单；实盘必须设置确认变量，且不能使用模拟盘 Key；
模拟盘客户端的请求地址指向 `demo-fapi.binance.com`；止损幅度超过强平距离、金额超过上限时拒绝下单；
交易记录能正确写入和读出数据库。

**第 2 步：检查连接（只读，不下单）**

浏览器打开 <http://127.0.0.1:3000/markets>，展开 **交易策略 → 测试策略**：

- 顶部显示橙色「模拟盘」标签和「可用 xxx USDT」，说明 Key 有效、连接的是模拟盘；
- 显示「余额读取失败：API-key format invalid（-2014）」等错误，说明 Key 填错或不是模拟盘 Key。

也可以用命令行查看同一份状态：

```bash
curl -s -H "Host: 127.0.0.1:3000" http://127.0.0.1:3000/api/trading
```

**第 3 步：模拟盘端到端测试**

选择做多或做空，核对金额、杠杆和保护参数，点击 **运行测试策略** 并在弹窗中确认。
在 **交易策略 → 下单记录** 中逐项核对：

| 测试项 | 操作 | 页面上应看到 | 币安模拟盘上应看到 |
| --- | --- | --- | --- |
| 开仓 + 挂保护单 | 运行测试策略 | 状态「持仓中」；订单：开仓·已成交、止损·已挂单、止盈·已挂单 | 「仓位」中有该合约；「条件单」中有两张止盈止损单 |
| 手动平仓 | 点击「市价平仓」 | 状态「已平仓 · 手动平仓」；止损、止盈·已撤销；平仓·已成交 | 仓位和条件单都消失 |
| 止损或止盈触发 | 把止损、止盈都改为 `0.2%` 再运行，等待价格波动 | 「已平仓 · 止损触发」或「止盈触发」，另一张条件单「已撤销」 | 仓位消失，条件单清空 |
| 持仓到期 | 持仓时间填 `1` 分钟，止损止盈填大一些（如 5%） | 约 1 分钟后「已平仓 · 持仓到期，市价平仓」 | 仓位和条件单都消失 |

触发检查每 5 秒运行一次，页面每 4 秒刷新一次，状态变化最多延迟约 10 秒。

**第 4 步：异常场景（都应拒绝下单，并显示中文原因）**

| 场景 | 预期提示 |
| --- | --- |
| 金额超过单笔上限（如 5000） | 下单金额超过单笔上限 |
| 交易对不存在（如 `NOPEUSDT`） | 不是可交易的币安 USDT 永续合约 |
| 5 倍杠杆、止损填 20% | 止损幅度必须小于 16.00%，否则可能先被强平 |
| 同一合约同方向已有进行中的交易 | 已有同方向的策略交易，本次不下单 |
| 币安上已有同方向手动仓位 | 在交易所已有同方向持仓，本次不下单 |
| 账户为单向持仓模式 | 请在币安 USDⓈ-M 合约设置中启用双向持仓 |
| 金额太小（低于交易所最小下单额） | 低于最小下单数量 / 最小下单金额 |

**第 5 步：服务重启恢复**

在持仓中时按 `Ctrl+C` 停止服务，再重新启动：止损止盈单仍挂在交易所，仓位不受影响；
重启后检查循环会接着管理这笔交易（检测触发、到期平仓）。

#### 常见错误

| 错误 | 原因与处理 |
| --- | --- |
| `API-key format invalid（-2014）` | Key 格式不对或填错，检查是否多复制了空格 |
| `Invalid API-key, IP, or permissions（-2015）` | Key 没有合约权限、IP 不在白名单，或把实盘 Key 用在了模拟盘（反之亦然） |
| `Margin is insufficient（-2019）` | 保证金不足，降低金额或提高杠杆 |
| `Rust 行情服务暂时不可用` | Rust 服务没启动或已退出，查看启动终端的报错 |
| 页面显示「仅本地模式可用」 | 没有用 `start-rust-markets.mjs` 启动，或不是通过 `127.0.0.1` / `localhost` 访问 |

#### 切换到实盘前

1. 先在模拟盘完成上面第 3、4 步的全部测试。
2. 实盘 API Key 只开「合约交易」权限，**不要开提现**，并绑定 IP 白名单。
3. 在实盘 USDⓈ-M 账户启用双向持仓。在 Playground 的 **账号设置** 登出旧账户后选「实盘」，
   填实盘 Key 和 Secret，并勾选真实资金下单确认后登录。
4. 实盘单笔上限默认 20 USDT，建议先用最小金额测试。仓库规定实盘测试每笔不得超过 25 美元。
5. 页面显示红色「实盘」标签，下单确认弹窗会额外提示「实盘，真实资金」。

On the docs deployment at `/playground`, press **Run** (or ⌘/Ctrl+Enter) to
execute a snippet. Switch languages with the tabs and load ready-made snippets
from **Examples…**.

## Deploy with Docker (recommended for any shared/public host)

Running user code directly on a host is unsafe (see **Sandboxing & safety**).
The Docker setup makes the **container the trust boundary** — user code can only
touch the container filesystem; the host is unreachable.
Use Docker Compose 2.17 or newer for the named CCXT Rust SDK build context.

```bash
cd docs/playground
PLAYGROUND_AI_URL=http://<host>:<port>/v1/chat/completions docker compose up --build
# → http://localhost:3000
```

The image starts the compiled Rust market service alongside Next.js. It
bundles every runner runtime (Node, Python, PHP, Go, .NET) with CCXT
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
  exchange API domains generated from CCXT (`proxy/`). Mining pools, C2,
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
> runtimes work. To build directly from `docs/playground`, run
> `docker build --platform linux/amd64 --build-context rust_sdk=../../rust .`.

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
