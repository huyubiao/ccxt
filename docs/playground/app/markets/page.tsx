"use client";

import { useEffect, useMemo, useState } from "react";
import MarketMonitor from "./market-monitor";
import Logo from "@/components/Logo";
import { apiUrl } from "@/lib/basePath";
import {
  exchangeLabels, marketExchanges, marketKinds, type MarketExchange, type MarketInstrument,
  type MarketKind, type MarketListing, type MarketQuote, type MarketVolume, type VolumeWindow,
} from "@/lib/market-lookup";
import { MINUTE_MS, VOLUME_DELAY_MS } from "@/lib/short-volume";
import { useMarketDirectory } from "./use-market-directory";
import { useLiveVolume } from "./use-live-volume";
import CoinFundamentals from "./coin-fundamentals";
import styles from "./markets.module.css";

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 12 });
const turnoverFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });

const marketTitles: Record<MarketKind, string> = { futures: "永续合约", spot: "现货", alpha: "Alpha" };
const contractTypes: Record<string, string> = {
  PERPETUAL: "永续", TRADIFI_PERPETUAL: "传统金融永续",
};
const preferredCoins = ["BTC", "ETH", "BNB", "SOL"];

function formatNumber(value: number | null) {
  return value === null ? "—" : numberFormat.format(value);
}

function pairLabel(pair: MarketInstrument) {
  const label = `${pair.base}/${pair.quote}`;
  if (pair.kind === "futures") return `${label} · ${contractTypes[pair.type] ?? pair.type} · ${pair.id}`;
  if (pair.kind === "alpha") return [label, pair.chain, pair.name, pair.id].filter(Boolean).join(" · ");
  return label;
}

function prioritizePair(a: MarketInstrument, b: MarketInstrument) {
  if (a.kind === "futures") {
    return Number(b.type === "PERPETUAL") - Number(a.type === "PERPETUAL") || a.id.localeCompare(b.id);
  }
  return a.id.localeCompare(b.id);
}

type Coin = { symbol: string; markets: Record<MarketExchange, MarketInstrument[]> };

export default function MarketsPage() {
  const binance = useMarketDirectory("binance");
  const okx = useMarketDirectory("okx");
  const platforms = { binance, okx };
  const [exchange, setExchange] = useState<MarketExchange>("binance");
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<string | null>(null);

  const coins = useMemo(() => {
    const grouped = new Map<string, Coin>();
    for (const { coin } of binance.directory?.futures.instruments ?? []) {
      if (!grouped.has(coin)) grouped.set(coin, { symbol: coin, markets: { binance: [], okx: [] } });
    }
    for (const [platform, directory] of [
      ["binance", binance.directory], ["okx", okx.directory],
    ] as const) {
      if (!directory) continue;
      for (const kind of marketKinds) {
        for (const pair of directory[kind].instruments) {
          grouped.get(pair.coin)?.markets[platform].push(pair);
        }
      }
    }
    const rank = (symbol: string) => {
      const index = preferredCoins.indexOf(symbol);
      return index < 0 ? preferredCoins.length : index;
    };
    return [...grouped.values()].sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  }, [binance.directory, okx.directory]);

  const coin = coins.find(({ symbol }) => symbol === selection);
  const referenceContract = coin?.markets.binance.filter((pair) => pair.kind === "futures").sort(prioritizePair)[0];
  const search = filter.trim().toUpperCase();
  const visible = coins.filter(({ symbol, markets }) => symbol.includes(search) ||
    markets.binance.some((pair) => pair.kind === "futures" && pair.id.includes(search)));
  const hasDirectory = binance.directory?.futures.updatedAt != null;
  const failedPlatforms = marketExchanges.filter((platform) => platforms[platform].syncError ||
    marketKinds.some((kind) => platforms[platform].directory?.[kind].stale));
  const platform = platforms[exchange];
  const activePairs = coin?.markets[exchange] ?? [];
  const kinds = exchange === "binance" ? marketKinds : (["futures", "spot"] as const);

  function selectCoin(item: Coin) {
    setSelection(item.symbol);
    if (!item.markets[exchange].length) setExchange("binance");
  }

  return (
    <main className={styles.page} lang="zh-CN">
      <header className={styles.header}>
        <div className={styles.brand}><Logo size={22} /> CCXT</div>
        <nav className={styles.sectionNav} aria-label="页面板块">
          <a href="#market-alerts">监控币种</a>
          <a href="#coin-research">币种深度调研</a>
        </nav>
      </header>

      <div className={styles.content}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>BINANCE · OKX</p>
          <h1>币种行情</h1>
          <p>监控币安合约价格异动，查看币安和 OKX 的币种详情。</p>
        </div>

        <section id="market-alerts" className={styles.monitorPanel} aria-labelledby="market-alert-heading">
          <h2 id="market-alert-heading" className={styles.sectionTitle}>监控币种</h2>
          <MarketMonitor />
        </section>
        <section id="coin-research" className={styles.workspace} aria-labelledby="coin-research-heading">
          <div className={styles.researchHeading}>
            <h2 id="coin-research-heading" className={styles.sectionTitle}>币种深度调研</h2>
            <p>选择有币安 USDT 本位永续合约的币种，查看市值、代币解锁、最新成交价和成交额。各平台仅显示 USDT 报价交易对。</p>
          </div>
          <section className={styles.directory} aria-label="可交易币种">
            <div className={styles.directoryHeader}>
              <h3>可交易币种</h3>
              {hasDirectory && <span>{visible.length} / {coins.length}</span>}
            </div>
            <input
              className={styles.filter}
              type="search"
              aria-label="筛选币种"
              placeholder="搜索币种，如 BTC"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className={styles.sync} role="status">
              {failedPlatforms.length ? `${failedPlatforms.map((venue) => exchangeLabels[venue]).join("、")}部分列表同步失败，正在重试。`
                : hasDirectory ? (binance.live ? "每 15 秒同步 · 币安合约通知已连接" : "每 15 秒同步币种列表")
                : "正在加载币种列表…"}
            </p>
            {visible.length > 0 ? (
              <ul className={styles.coins}>
                {visible.map((item) => (
                  <li key={item.symbol}>
                    <button type="button" aria-pressed={item.symbol === selection} onClick={() => selectCoin(item)}>
                      <strong>{item.symbol}</strong>
                      <span>{marketExchanges.filter((venue) => item.markets[venue].length > 0).map((venue) => exchangeLabels[venue]).join(" · ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : hasDirectory && <p className={styles.noMatches}>没有匹配的币种。</p>}
          </section>

          <section aria-label="行情结果" className={styles.results}>
            {coin ? (
              <>
                <h3 className={styles.coinTitle}>{coin.symbol} 行情</h3>
                {referenceContract && <CoinFundamentals key={referenceContract.id} symbol={referenceContract.id} />}
                <div className={styles.platforms} role="group" aria-label="交易平台">
                  {marketExchanges.map((venue) => (
                    <button key={venue} type="button" aria-pressed={venue === exchange} onClick={() => setExchange(venue)}>
                      {exchangeLabels[venue]}
                    </button>
                  ))}
                </div>
                {activePairs.some(({ kind }) => kind === "alpha") && (
                  <p className={styles.coinNote}>Alpha 按币种代码匹配，请用链和代币地址核对同名代币。</p>
                )}
                <div className={styles.marketGrid} data-market-count={kinds.length}>
                  {platform.directory ? kinds.map((kind) => (
                    <MarketPanel key={`${coin.symbol}:${exchange}:${kind}`} kind={kind}
                      pairs={activePairs.filter((pair) => pair.kind === kind)} listing={platform.directory![kind]} />
                  )) : <p role="status">{platform.syncError ? "目录同步失败，正在重试。" : "正在同步交易对…"}</p>}
                </div>
              </>
            ) : (
              <div className={`${styles.result} ${styles.empty}`}>
                {selection && hasDirectory && !binance.syncError && !binance.directory?.futures.stale ? (
                  <><strong>{selection} 已不在可交易列表中</strong><p>请从更新后的列表选择其他币种。</p></>
                ) : (
                  <><strong>请选择一个币种</strong><p>点击左侧的币种查看各市场行情和成交额。</p></>
                )}
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

function MarketPanel({ kind, pairs, listing }: { kind: MarketKind; pairs: MarketInstrument[]; listing: MarketListing }) {
  const [selection, setSelection] = useState<string | null>(null);
  const sorted = [...pairs].sort(prioritizePair);
  const pair = sorted.find(({ id }) => id === selection) ?? sorted[0];
  return (
    <section className={styles.result} aria-label={marketTitles[kind]}>
      <h3 className={styles.marketTitle}>{marketTitles[kind]}</h3>
      {listing.stale && pair && <p className={styles.time}>交易对列表同步失败，暂用上次结果。</p>}
      {pair ? (
        <>
          {sorted.length > 1 ? (
            <label className={styles.pairSelect}>
              <span>交易对</span>
              <select aria-label={`${marketTitles[kind]}交易对`} value={pair.id} onChange={(event) => setSelection(event.target.value)}>
                {sorted.map((option) => <option key={option.id} value={option.id}>{pairLabel(option)}</option>)}
              </select>
            </label>
          ) : <p className={styles.pairLabel}>{pairLabel(pair)}</p>}
          {pair.kind === "alpha" && pair.address && (
            <p className={styles.address} title={pair.address}>代币地址：{pair.address}</p>
          )}
          <PairData key={pair.id} pair={pair} />
        </>
      ) : (
        <p className={styles.marketEmpty}>{listing.stale ? "暂时无法确认交易对，正在重试。"
          : "该市场暂无此币种的 USDT 交易对。"}</p>
      )}
    </section>
  );
}

function PairData({ pair }: { pair: MarketInstrument }) {
  const { id: symbol, kind, exchange = "binance" } = pair;
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ exchange, market: kind, symbol });

    async function fetchQuote() {
      try {
        const response = await fetch(apiUrl(`/api/markets/ticker?${params}`), {
          cache: "no-store",
          signal: request.signal,
        });
        const body = await response.json();
        if (request.signal.aborted) return;
        if (!response.ok) throw new Error(body?.error ?? "无法获取行情。");
        setQuote(body);
        setError(null);
      } catch (error) {
        if (!request.signal.aborted) setError(error instanceof Error ? error.message : "无法获取行情。");
      } finally {
        if (!request.signal.aborted) timer = setTimeout(fetchQuote, 10000);
      }
    }

    void fetchQuote();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [exchange, kind, symbol]);

  return (
    <>
      {quote && <Quote pair={pair} quote={quote} />}
      {error ? <p className={styles.marketEmpty} role="status">{error}</p>
        : !quote && <p className={styles.marketEmpty} role="status">正在获取行情…</p>}
      <TradeVolume pair={pair} />
    </>
  );
}

const periodLabels = {
  "5s": "近 5 秒", "30s": "近 30 秒", "1m": "近 1 分钟",
  "5m": "近 5 分钟", "1h": "近 1 小时", "24h": "近 24 小时", "7d": "近 7 天",
};

const emptyHistory: VolumeWindow[] = (["5m", "1h", "24h", "7d"] as const).map((period) => ({ period, amounts: null }));

function TradeVolume({ pair }: { pair: MarketInstrument }) {
  const { id: symbol, kind, exchange = "binance" } = pair;
  const external = exchange !== "binance";
  const totalOnly = kind === "alpha";
  const live = useLiveVolume(pair);
  const [history, setHistory] = useState<MarketVolume | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ exchange, market: kind, symbol, view: "history" });

    async function loadVolume() {
      let nextRefresh = 10000;
      try {
        const response = await fetch(apiUrl(`/api/markets/volume?${params}`), {
          cache: "no-store",
          signal: request.signal,
        });
        if (!response.ok) {
          if (response.status === 429) nextRefresh = 30000;
          throw new Error("Could not load historical turnover.");
        }
        const body: MarketVolume = await response.json();
        if (request.signal.aborted) return;
        setHistory(body);
        setError(false);
        nextRefresh = Math.max(1000, body.asOf + MINUTE_MS + VOLUME_DELAY_MS + 250 - Date.now());
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(loadVolume, nextRefresh);
      }
    }

    void loadVolume();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [exchange, kind, symbol]);

  const closedMinute = history?.windows.find(({ period }) => period === "1m");
  const useClosedMinute = closedMinute?.total != null &&
    live.windows.some(({ period, amounts }) => period === "1m" && amounts === null);
  const windows = [
    ...live.windows.map((window) => useClosedMinute && window.period === "1m" ? closedMinute : window),
    ...(history?.windows.filter(({ period }) => period !== "1m") ?? emptyHistory)
      .map((window) => live.closedWindows.find(({ period }) => period === window.period) ?? window),
  ];
  const turnoverLabel = totalOnly ? "总成交额" : external ? "成交额" : "主动买卖成交额";

  return (
    <section className={styles.turnover} aria-label={turnoverLabel}>
      <h4>{turnoverLabel} <span>USDT</span></h4>
      <div className={styles.tableScroll}>
        <table>
          <thead><tr>
            <th scope="col">统计区间</th>
            {totalOnly ? <th scope="col">成交额</th> : <>
              <th scope="col">主动买入{kind === "futures" && <small>（做多 + 平空）</small>}</th>
              <th scope="col">主动卖出{kind === "futures" && <small>（做空 + 平多）</small>}</th>
              {external && <th scope="col">总额</th>}
            </>}
          </tr></thead>
          <tbody>
            {windows.map(({ period, amounts, total, asOf }) => (
              <tr key={period}>
                <th scope="row">
                  {useClosedMinute && period === "1m" ? "上一根已收盘 1 分钟 K 线" : periodLabels[period]}
                  {asOf != null && <small>截至 {timeFormat.format(asOf)}</small>}
                </th>
                {totalOnly ? <td>{total != null ? turnoverFormat.format(total) : "—"}</td> : <>
                  <td className={styles.buy}>{amounts ? turnoverFormat.format(amounts.buy) : "—"}</td>
                  <td className={styles.sell}>{amounts ? turnoverFormat.format(amounts.sell) : "—"}</td>
                  {external && <td>{total != null ? turnoverFormat.format(total) :
                    amounts ? turnoverFormat.format(amounts.buy + amounts.sell) : "—"}</td>}
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {live.asOf !== undefined ? <p>短区间每秒更新 · <time dateTime={new Date(live.asOf).toISOString()}>{timeFormat.format(live.asOf)}</time></p>
        : <p role="status">{live.reconnecting ? "正在重连并补齐短区间成交…" : "正在同步最近一分钟的成交…"}</p>}
      {history && <p>{external ? "未单独标注时间的长区间总额按已收盘 K 线统计" : "长区间按已收盘 K 线统计"} · <time dateTime={new Date(history.asOf).toISOString()}>{timeFormat.format(history.asOf)}</time></p>}
      {error && <p role="status">长区间同步失败，稍后会自动重试。</p>}
      {totalOnly && <p>Alpha 公开成交数据的方向字段已弃用，仅统计总成交额。</p>}
      {external && (kind === "spot"
        ? <p>现货主动买卖额从本次连接起累计，覆盖完整区间后显示。断线重连后重新累计。</p>
        : <p>永续合约长区间的主动买卖额来自 OKX 已结束的统计周期，截止时间见各行。</p>)}
      {windows.some(({ amounts, total }) => total == null && amounts === null) && <p>— 表示该时段暂无完整成交额或换算数据。</p>}
    </section>
  );
}

function Quote({ pair, quote }: { pair: MarketInstrument; quote: MarketQuote }) {
  const metrics = [
    { label: "24 小时涨跌幅", value: quote.changePercent === null ? "—" : `${percentFormat.format(quote.changePercent)}%` },
    { label: `24 小时成交量（${pair.base}）`, value: formatNumber(quote.baseVolume) },
  ];
  const time = quote.timestamp ?? quote.fetchedAt;

  return (
    <>
      <dl className={styles.last}>
        <dt>最新成交价（{pair.quote}）</dt>
        <dd>{formatNumber(quote.last)}</dd>
      </dl>
      <dl className={styles.metrics}>
        {metrics.map(({ label, value }) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      <p className={styles.quoteTime}>
        {quote.timestamp === null ? "查询时间" : "行情时间"}{" "}
        <time dateTime={new Date(time).toISOString()}>{timeFormat.format(time)}</time>
      </p>
    </>
  );
}
