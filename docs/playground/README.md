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

Each confirmed alert starts with a low-confidence momentum forecast using the
trigger price and direction. Its move is 20% of the alert's absolute move,
bounded to 0.05%–3%. With sufficient directional evidence and a fresh price,
a forecast based on recent taker trades, near-midpoint depth, and estimated
liquidation pressure replaces it. Open interest change and holder
concentration scale the estimated move. An unusually large aggregate fill
is a proxy for aggressive buying or selling.

The forecast fixes the baseline at publication and settles on the first
one-minute candle close at least five minutes later. The table compares the
estimated move with the realized move and reports direction hits and mean
absolute error in percentage points over settled forecasts in the latest
100 alert samples. Records stay in the browser and due forecasts can settle
after reopening the page. Older records with only the alert move display a
retrospective estimate without a settlement score.

Research shows Binance liquidation pressure bands, also
available via `GET /api/markets/liquidations?symbol=JCTUSDT`. The response
includes the model version, mark price, snapshot and open-interest timestamps,
and ranked bands with direction, price bounds, distance, estimated liquidation
notional (`estimatedLiquidationUsdt`), and relative strength. The chart and API
also report `cumulativeEstimatedLiquidationUsdt`, summing same-side bands from
the mark to the outside edge of each target band.
The liquidation model allocates initial and newly opened positions on each
side across baseline 1x, 2x, 3x, 5x, 10x, and 20x scenarios. Both live
estimates and replay read the current Binance public leverage and margin
schedule. The first bracket provides the leverage ceiling. If the ceiling
is above 20x, half of the 20x weight is distributed equally across supported
50x, 75x, 100x, 125x and ceiling scenarios, including the ceiling once.
Below 20x, unsupported tiers are merged into the ceiling. The snapshot is
cached for one hour. Trigger prices use the maintenance rate and deduction
for the modeled account notional at the trigger. Representative entry
notionals are half the first bracket cap above 20x and twice the first cap
otherwise, limited to 95% of the largest cap permitted at that leverage.
If the schedule is unavailable, BTCUSDT falls back to splitting
the 20x allocation into 20x, 50x, 75x, and 100x at 50%, 25%, 15%, and 10%.
CAKEUSDT splits its 20x allocation into 20x, 50x, and 75x at 75%, 20%, and 5%.
In those two fallback profiles, scenarios above 20x use the published first-bracket
maintenance rate (0.4% for BTCUSDT and 1% for CAKEUSDT).
These shares are uncalibrated. The model selects the longest
complete 360-, 180-, 60-, or 30-day daily circulating market-cap window.
Contracts listed on Binance for less than 30 days can use available
post-listing daily samples. CoinGecko is preferred, with the Binance/CMC
daily proxy as a fallback. The cap bands have upper bounds of USD 20M,
60M, 200M, 1B, 5B, and 30B, with the last band starting at 30B. Without history,
BTC and ETH use the top band and other contracts use the bottom band.

Turnover uses Binance's rolling 24-hour perpetual quote volume in USDT divided
by the latest circulating market cap in USD, treating USDT as USD for this
ratio. Its six bands split at 17.5%, 25%, 50%, 100%, and 200%, including equality
in the lower band. Missing turnover leaves the turnover adjustment neutral.
`leverageWeighting` returns both inputs, band factors, and applied weights.
The product of the two factors scales the 5x, 10x, and 20x baseline allocations
by its square root, itself, and its square respectively. The remaining weight
goes to 1x, 2x, and 3x. The 1x share of that pool starts at 20% for longs and
30% for shorts and gains `0.25 × (1 − combined factor)`; 2x and 3x share the
rest in their original proportions. The baseline assumes
a 75/25 notional mix of larger and smaller positions. `marginScenarios` then
splits each leverage allocation among positions adding 0%, 25%, 50%, 100%,
or 200% of initial margin. The corresponding quantity weights are
35/25/20/15/5% for longs and 15/20/25/25/15% for shorts. These are uncalibrated
assumptions about collateral available before liquidation.
Individual account balances, deposit timing, and fees are outside the inputs.
At the start of the reconstruction, the model distributes the observed initial
open interest across entry proxies at the previous completed mark candle's
low, close, and high (25%, 50%, 25%). It retains only scenarios that could still
be open at that close. If the preceding mark candle is missing, the model
starts tracking from subsequent changes. For new positions it uses the
five-minute mark close as the entry proxy. Additional margin moves the trigger
farther from entry.
Nonpositive liquidation prices are excluded from price bands.
`positionAddScenario` assigns up to 20% of a positive open-interest change
per side to one-time adds to surviving cohorts. A cohort must have closed at
least halfway from its entry to its liquidation price. The added tranche uses
the same leverage and fresh initial margin. The model assigns size only where
the combined liquidation price moves farther from the mark, with a cap of 25%
of each eligible cohort's surviving size. It deducts allocated size from the
same-side quantity available for new cohorts. This is an uncalibrated scenario.
The model reduces cohorts as open interest falls and removes levels crossed by
the mark after formation. It estimates additional turnover that leaves net open
interest unchanged using regular contract candle volume. The per-side bound for
equal replacement on both sides is the minimum of starting open interest,
ending open interest, and half the volume remaining after the absolute net
change. The model replaces 10% of that bound at the candle close. Missing or
inconsistent volume leaves only the net open-interest update.
Estimated notional sums modeled position quantity times estimated liquidation
price within each band. Actual forced fills and trader losses are separate
metrics. Strength is normalized to the largest surviving band in each snapshot.
The liquidation estimates refresh about once a minute. The tables group fine
bands into wider ranges up to −80% for longs and +300% for shorts, keeping price order.
The collapsible spike list shows the bounds and estimated amounts of qualifying
0.5% price bands, with longs on the left and shorts on the right. Each side is
sorted by amount, largest first. A band qualifies when its amount reaches 20% of
its side's largest band and is at least twice each neighboring mean, computed
from up to two same-side bands in each direction. Empty neighboring bands count as zero.
Forecast responses identify their amount basis and validation status as
`modeled-notional` and `uncalibrated`.
The `coverage` field reports the latest open-interest quantity and the modeled
long and short quantities included in the chart. Each side is compared separately
with the same open-interest quantity. The page leaves coverage unavailable when
open interest is zero and labels zero table amounts as unavailable from the model.
For backtesting, retain snapshots with their capture time. An empty list means
no modeled levels survived, whereas HTTP 502 means inputs were unavailable.

The research panel's 24-hour backtest also has an API at
`GET /api/markets/liquidations/backtest?symbol=INITUSDT`. It replays closed
five-minute Binance mark and open-interest bars in order, initializing cohorts
from up to 72 preceding hours of consecutive data. Live snapshots use the
same maximum position history. The replay freezes the leverage weights at the start
of the tested period and counts each modeled cohort only on its first touch.
The window ends one bar before the latest five-minute boundary to allow open
interest to publish. Swolecharts and CoinBoss provide historical HTTP data.
CryptoHFTData provides hourly Binance Parquet files, summed at average fill
price times filled quantity in USDT. Missing files are reported as partial
coverage because files may lag or be absent in quiet hours. References are
filtered to the same Binance perpetual contract and compared separately.
Archive coverage does not imply coverage of every forced fill on Binance.
The replay runs the same position model as the live price bands. The interval
comparison reports per-side turnover bounds and estimated replacements in base
units. It groups the selected source and side by whether the five-minute mark
high divided by the low minus one reaches 1%, then reports zero-estimate misses
among intervals with recorded events and signed aggregate amount differences.
Third-party amounts are used only for comparison. Deltas against incomplete references
are labeled as sample comparisons and cannot measure full-window error.
If no modeled price is touched, the API and table display numeric zero.
A reference with records on that side flags a model miss. With a verified
exchange margin profile, 20% of unaugmented positions above 20x are modeled
with one quarter of the original price buffer to represent cross-margin
accounts with impaired collateral. This redistributes modeled quantity
without increasing it.
The API returns 5-minute model and per-provider buckets, with separate
long/short deltas. The page ranks 5-minute differences for the selected
direction and source. Missing buckets from a partial source stay unknown.
When older data is available, the response also reports the result of
rebuilding with up to 24 hours of warmup while holding model assumptions
constant.

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
is the holder's token balance divided by maximum supply. Coins without a
verified supply cap still show balances. Results identify the chain and
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

Use the price monitor embedded in the market page to watch all listed Binance
USDT perpetual contracts. Inside the strategy panel, **告警记录** and **涨跌预测**
can be expanded or collapsed independently. The **超阈值记录** navigation opens
the price-trigger history while monitoring continues. Monitoring starts off by default.
Turning it off closes the price stream and cancels pending checks.
Set the window in whole seconds (1 to 300, default 30)
and enable upward alerts, downward alerts, or both, with separate thresholds.
Both thresholds have a minimum magnitude of 1%. Downward thresholds must
be below 100%. Previously saved settings below 1% or above 300 seconds are
adjusted to the new bounds when the page loads.
Each direction maintains its own rolling samples and alert levels.
Changing the price thresholds or window restarts sampling. Existing signed
threshold settings migrate to the corresponding direction.
The monitor samples the latest received price once per second. A rule
triggers when its signed percentage threshold is reached or exceeded.
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
window starts, scaled to its duration. The latest 100 price triggers and
their check results stay in the browser. Data gaps or interrupted checks
remain visible in the history. Confirmed alerts appear in the strategy panel
and can also be sent to a DingTalk group robot.

On Windows, launch with `start-playground.cmd` and open **交易策略 → 钉钉推送**
on the local market page. Paste the group robot Webhook and, if signing is
enabled, its signing secret. Click **保存并启用**, then **发送测试消息** to check
delivery. On the local settings page, enter up to 500 characters of custom text
or leave the test message field blank to send the default. Then click
**异动监控 → 开启钉钉通知** to send confirmed alerts
from the monitor. This switch is off by default and is saved in the browser;
**停止钉钉通知** stops sending while alerts continue to appear on the page.
Use **暂停推送** or **恢复推送** for the server-wide robot setting. Keep the
market page open for live monitoring. Existing `DINGTALK_WEBHOOK_URL` and
`DINGTALK_WEBHOOK_SECRET` values act as a fallback until a robot is saved on
the local page. To enable editing when starting the server manually, set `PLAYGROUND_LOCAL_SETTINGS=1`
and bind Next.js to `127.0.0.1`.
Server-side strategies can call `strategyNotifier.send({ title, lines })` from
`lib/strategy-notifications.ts`. Browser strategies add a typed event and a
server-side template in `lib/strategy-notification-events.ts`.

The browser saves the switch, window, price thresholds, and turnover multiple locally. The monitor
starts a new price window after reconnecting, re-enabling, or changing the duration.
Alerts include the level and the latest available five-minute long/short
ratios at the trigger time. The first trigger records the checked USDT
turnover. Both venues show the
all-account ratio. Binance shows the top-trader position ratio, and OKX shows
the top-trader account ratio for the matching USDT perpetual. OKX cells show
the reason when a contract or its statistics are unavailable.

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
- **egress allowlist** → the app runs on an internet-less `internal` network; all
  outbound goes through the `egress-proxy` (squid) sidecar, which permits **only
  the exchange API domains generated from CCXT** (`proxy/`). Mining pools, C2,
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
