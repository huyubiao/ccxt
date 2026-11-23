"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { formatMarketAmount, formatMarketPriceRange, fullMarketNumber, marketNumberFormatter } from "@/lib/market-number";
import { readMarketResponse } from "@/lib/market-response";
import {
  LIQUIDATION_INTERVAL_MS, LIQUIDATION_REFRESH_MS, LIQUIDATION_RISK_BAND_SHARES, MARK_RANGE_MIN_COUNT, positionExitScenario,
  type LiquidationLevels, type LiquidationRiskBand,
} from "@/lib/liquidation-levels";
import {
  estimateLiveWindow, LIVE_LIQUIDATION_WINDOW_LIMIT, rememberLiveSnapshot, subscribeBinanceLiquidations,
  type AvailableRiskSnapshot, type ClosedMarkBar, type LiquidationStreamPeriod, type LiquidationStreamStatus,
  type LiveWindowComparison, type LiveWindowEstimate,
} from "@/lib/liquidation-live";
import styles from "./markets.module.css";

const price = marketNumberFormatter({ maximumSignificantDigits: 8 });
const amount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const weightPercent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const leveragePercent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 4 });
const coefficient = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
const liveTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Shanghai" });
const windowStartTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Shanghai" });
const windowEndTime = new Intl.DateTimeFormat("zh-CN", { timeStyle: "short", timeZone: "Asia/Shanghai" });

function displayCoverage(quantity: number, openInterest: number) {
  const share = quantity / openInterest;
  return share > 0 && share < 0.0001 ? "<0.01%" : weightPercent.format(share);
}

function LiquidationModelParameters({ weighting }: { weighting: LiquidationLevels["leverageWeighting"] }) {
  const { capitalization, marketCapBand, volatilityLevel, volatilityFactor, volatilityCounts, factor, weights, thresholds } = weighting;
  const thresholdIndex = volatilityLevel - 2;
  const volatilityBasis = volatilityCounts === null ? "近 24 小时样本不足，使用默认档"
    : thresholdIndex < 0 ? `近 24 小时振幅超过 ${weightPercent.format(thresholds[0])} 的 K 线不足 ${MARK_RANGE_MIN_COUNT} 根`
    : `近 24 小时有 ${volatilityCounts[thresholdIndex]} 根 K 线振幅超过 ${weightPercent.format(thresholds[thresholdIndex])}`;

  return <section className={styles.liquidationParameters} aria-label="强平模型参数">
    <h5>模型参数</h5>
    <dl className={styles.metrics}>
      <div><dt>市值系数</dt><dd><strong>{coefficient.format(marketCapBand.factor)}</strong>
        <small>{marketCapBand.label} · {capitalization
          ? `${capitalization.windowDays} 天流通市值中位数 ${formatMarketAmount(capitalization.medianUsd)} USD`
          : "缺少市值历史，使用默认档位"}</small>
      </dd></div>
      <div><dt>波动系数</dt><dd><strong>{coefficient.format(volatilityFactor)}</strong>
        <small>第 {volatilityLevel} 档 · {volatilityBasis}</small>
      </dd></div>
      <div><dt>综合系数</dt><dd><strong>{coefficient.format(factor)}</strong><small>市值系数 × 波动系数</small></dd></div>
    </dl>
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="当前新开仓杠杆权重">
      <table>
        <caption>当前新开仓杠杆权重</caption>
        <thead><tr>
          <th scope="col">方向</th>
          {weights.map(({ leverage }) => <th key={leverage} scope="col">{leverage} 倍</th>)}
        </tr></thead>
        <tbody>
          <tr><th scope="row">模型有效保证金率</th>
            {weights.map(({ leverage, effectiveMarginRate }) => <td key={leverage}>{leveragePercent.format(effectiveMarginRate ?? 1 / leverage)}</td>)}
          </tr>
          <tr><th scope="row" className={styles.sell}>多头</th>
            {weights.map(({ leverage, long }) => <td key={leverage}>{leveragePercent.format(long)}</td>)}
          </tr>
          <tr><th scope="row" className={styles.buy}>空头</th>
            {weights.map(({ leverage, short }) => <td key={leverage}>{leveragePercent.format(short)}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
    <p>波动档位按最近 24 小时已收盘的 5 分钟标记价 K 线计算。历史仓位沿用开仓时的杠杆。</p>
    <p>上涨时单侧换手的 {weightPercent.format(positionExitScenario.directionalTurnoverShare)} 分给平多，下跌时同样偏向平空。
      单侧换手新仓用该 5 分钟的合约成交均价估算入场价，缺少均价时用标记价收盘价。已触发的强平先抵扣同侧退出额度。</p>
    <p>剩余成交量产生的双平和换手退出，{weightPercent.format(positionExitScenario.preferredExitShare)} 优先处理盈亏幅度小的仓位，幅度相同时先处理离强平价较远的仓位。
      {weightPercent.format(positionExitScenario.oldStockExitShare)} 优先替换回看起点未识别的旧仓，再处理建仓最早的可退出批次。
      {weightPercent.format(positionExitScenario.highProfitExitShare)} 按盈利比例从高到低分配，{weightPercent.format(positionExitScenario.nearLiquidationExitShare)} 按持仓数量比例分给接近强平的亏损仓位。</p>
  </section>;
}


const riskLabel = { low: "低", elevated: "中", high: "高", extreme: "极高" } as const;
const sideLabel = { long: "多头", short: "空头" } as const;
const riskOpacity = { low: 0.3, elevated: 0.7, high: 0.88, extreme: 1 } as const;
const liquidationSides = ["long", "short"] as const;

function LiquidationChart({ data }: { data: LiquidationLevels }) {
  const [selection, setSelection] = useState<{ side: LiquidationRiskBand["side"]; price: number }>();
  const chart = useRef<HTMLDivElement>(null);
  const bands = [...data.levels].sort((a, b) => a.lowerPrice - b.lowerPrice);
  if (!bands.length) return <p>本次快照暂无可绘制的强平价带。</p>;

  const minimum = Math.min(data.markPrice, bands[0].lowerPrice);
  const maximum = Math.max(data.markPrice, bands.at(-1)!.upperPrice);
  const bandRatio = data.bandWidthPercent / 100;
  const { high: highThreshold, extreme: extremeThreshold } = LIQUIDATION_RISK_BAND_SHARES;
  const ceiling = Math.max(extremeThreshold, ...bands.map((band) => band.openInterestShare)) * 1.12;
  const width = 820, left = 72, right = 774;
  const x = (value: number) => left + (value - minimum) / (maximum - minimum) * (right - left);
  const mark = x(data.markPrice);
  const midpoint = (band: LiquidationRiskBand) => (band.lowerPrice + band.upperPrice) / 2;

  const sideBands = liquidationSides.map((side) => {
    const candidates = bands.filter((band) => band.side === side && band.riskLevel !== "low");
    const ranked = candidates.sort((a, b) => b.openInterestShare - a.openInterestShare ||
      Math.abs(a.distancePercent) - Math.abs(b.distancePercent));
    const highCount = ranked.filter((band) => band.riskLevel === "high").length;
    const extremeCount = ranked.filter((band) => band.riskLevel === "extreme").length;
    const counts = [extremeCount > 0 ? `${extremeCount} 个极高风险` : "", highCount > 0 ? `${highCount} 个高风险` : ""]
      .filter(Boolean).join(" · ");
    return { side, counts, picks: ranked.slice(0, Math.max(3, highCount + extremeCount)) };
  });
  const picks = sideBands.flatMap(({ picks }) => picks);
  const active = picks.find((band) => selection?.side === band.side &&
    selection.price >= band.lowerPrice && selection.price < band.upperPrice) ??
    picks.sort((a, b) => b.openInterestShare - a.openInterestShare)[0];
  const top = active ? 78 : 30, bottom = top + 170;
  const y = (share: number) => bottom - share / ceiling * (bottom - top);
  const activeRange = active ? formatMarketPriceRange(active.lowerPrice, active.upperPrice, price) : "";
  const anchor = active ? x(midpoint(active)) : 0;
  const labelWidth = Math.max(196, activeRange.length * 7.5 + 56);
  const labelLeft = Math.max(left, Math.min(anchor - labelWidth / 2, right - labelWidth));
  const labelTip = Math.max(labelLeft + 12, Math.min(anchor, labelLeft + labelWidth - 12));

  function selectBand(band: LiquidationRiskBand) {
    const center = midpoint(band);
    setSelection({ side: band.side, price: center });
    if (chart.current) chart.current.scrollLeft = x(center) / width * chart.current.scrollWidth - chart.current.clientWidth / 2;
  }

  return (
    <figure className={styles.liquidationChart}>
      <figcaption>
        <span className={styles.sell}><i className={styles.liquidationLegendSquare} />多头强平</span>
        <span className={styles.buy}><i className={styles.liquidationLegendSquare} />空头强平</span>
        <span><i className={styles.liquidationLegendMark} />当前标记价</span>
        <span><i className={styles.liquidationLegendThreshold} />高风险线 {weightPercent.format(highThreshold)}</span>
        <span><i className={`${styles.liquidationLegendThreshold} ${styles.liquidationExtremeLegend}`} />极高风险线 {weightPercent.format(extremeThreshold)}</span>
        <span>每段宽度为当前标记价的 {weightPercent.format(bandRatio)}（约 {price(data.markPrice * bandRatio)} USDT）</span>
      </figcaption>
      <div className={styles.liquidationRiskGroups} role="group" aria-label="重点强平风险价带">
        {sideBands.map(({ side, counts, picks }) => <section key={side} aria-label={sideLabel[side] + "重点价带"}>
          <h5><span className={side === "long" ? styles.sell : styles.buy}>{sideLabel[side]}</span>
            <span>{counts || "暂无高风险价带"}</span></h5>
          <div className={styles.liquidationRiskList}>
            {picks.map((band) => <button key={band.lowerPrice} type="button"
              className={styles.liquidationRiskChoice} data-side={side} data-risk={band.riskLevel}
              aria-pressed={active === band} onClick={() => selectBand(band)}>
              <span className={styles.liquidationRiskBadge}>{riskLabel[band.riskLevel]}风险</span>
              <span className={styles.liquidationRiskPrice}>{formatMarketPriceRange(band.lowerPrice, band.upperPrice, price)}</span>
              <strong title={`占${sideLabel[side]}总量的比例`}>{displayCoverage(band.openInterestShare, 1)}</strong>
            </button>)}
          </div>
        </section>)}
      </div>
      <div ref={chart} className={`${styles.tableScroll} ${styles.liquidationPlot}`} tabIndex={0} role="region" aria-label="强平风险价带">
        <svg viewBox={`0 0 ${width} ${bottom + 42}`} role="img" aria-label="价格区间里的仓位占多头或空头总量的比例">
          <text x={left} y={top - 8}>占多头或空头总量的比例</text>
          {[0, 0.5, 1].map((ratio) => {
            const tick = y(ceiling * ratio);
            return <g key={ratio}>
              <line className={styles.liquidationGridline} x1={left} x2={right} y1={tick} y2={tick} />
              <text x={left - 8} y={tick + 4} textAnchor="end">{weightPercent.format(ceiling * ratio)}</text>
            </g>;
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const value = minimum + (maximum - minimum) * ratio;
            return <text key={ratio} x={x(value)} y={bottom + 18} textAnchor="middle">
              {price(value).length > 12 ? value.toExponential(4) : price(value)}
            </text>;
          })}
          <text x={(left + right) / 2} y={bottom + 37} textAnchor="middle">标记价 (USDT)</text>
          {bands.map((band) => {
            const start = x(band.lowerPrice);
            const bandWidth = x(band.upperPrice) - start;
            const barTop = Math.min(bottom - 1, y(band.openInterestShare));
            const isExtreme = band.riskLevel === "extreme";
            const isHigh = isExtreme || band.riskLevel === "high";
            return <g key={band.lowerPrice} className={band.side === "long" ? styles.sell : styles.buy}>
              <title>{`${formatMarketPriceRange(band.lowerPrice, band.upperPrice, price)} · ${sideLabel[band.side]}${riskLabel[band.riskLevel]}风险 · 占${sideLabel[band.side]}总量 ${displayCoverage(band.openInterestShare, 1)}`}</title>
              {(isHigh || active === band) && <rect x={start} y={top} width={bandWidth} height={bottom - top}
                fill="currentColor" fillOpacity={isExtreme || active === band ? 0.19 : 0.09} />}
              <rect x={start} y={barTop} width={bandWidth} height={bottom - barTop}
                fill="currentColor" fillOpacity={riskOpacity[band.riskLevel]} />
              {isHigh && <line x1={start} x2={start + bandWidth} y1={barTop} y2={barTop} stroke="currentColor" strokeWidth={isExtreme ? 4 : 3} />}
            </g>;
          })}
          <line className={styles.liquidationThreshold} x1={left} x2={right} y1={y(highThreshold)} y2={y(highThreshold)} />
          <line className={`${styles.liquidationThreshold} ${styles.liquidationExtremeThreshold}`}
            x1={left} x2={right} y1={y(extremeThreshold)} y2={y(extremeThreshold)} />
          <line className={styles.liquidationMark} x1={mark} x2={mark} y1={top} y2={bottom} />
          {active && <g className={`${styles.liquidationCallout} ${active.side === "long" ? styles.sell : styles.buy}`}>
            <path d={`M ${labelTip} 54 V 60 L ${anchor} 71 V ${bottom}`} />
            <rect x={labelLeft} y={10} width={labelWidth} height={44} rx={7} />
            <text x={labelLeft + 12} y={28} className={styles.liquidationCalloutRisk}>
              {riskLabel[active.riskLevel]}风险 · 占{sideLabel[active.side]}总量 {displayCoverage(active.openInterestShare, 1)}
            </text>
            <text x={labelLeft + 12} y={44}>{activeRange} USDT</text>
          </g>}
        </svg>
      </div>
    </figure>
  );
}


const streamStatusLabels = { connecting: "正在连接币安", connected: "币安推送已连接", reconnecting: "币安推送断开，正在重连" } as const;

const difference = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const differenceRate = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero" });

function LiveLiquidationPanel({ windows, status, marksUnavailable }: {
  windows: LiveWindowComparison[]; status: LiquidationStreamStatus; marksUnavailable: boolean;
}) {
  return <section className={styles.liquidationLive} aria-label="币安强平金额对照">
    <div className={styles.liquidationLiveHeader}>
      <h5>币安强平金额对照 · 5 分钟</h5>
      <span className={status === "connected" ? styles.buy : undefined} role="status">{streamStatusLabels[status]}</span>
    </div>
    <p>每根 K 线使用开盘时已收到、行情时间距开盘不超过 3 分钟的最新风险图。收盘后，用标记价最低点算多头、最高点算空头。每批触发仓位的金额等于数量乘以该批强平价。</p>
    <p>币安金额按成交推送累计。偏差等于差额除以币安推送金额。币安公开推送有抽样，监测未覆盖整根 K 线时，会把收到的金额标为部分数据。</p>
    {marksUnavailable && <p role="status">标记价 K 线暂不可用，正在重试。</p>}
    {windows.length ? <div className={styles.tableScroll + " " + styles.liquidationScroll} tabIndex={0} role="region" aria-label="每根 K 线的强平金额对照">
      <table aria-label="每根 K 线的强平金额对照">
        <thead><tr><th scope="col">K 线时段（北京）</th><th scope="col">方向</th><th scope="col">标记价极值</th>
          <th scope="col">事前预测时间</th><th scope="col">触及的估算强平价</th><th scope="col">模型（USDT）</th>
          <th scope="col">币安推送（USDT）</th><th scope="col">差额（模型减币安）</th><th scope="col">偏差</th></tr></thead>
        <tbody>{windows.flatMap((window) => ([...liquidationSides, "total"] as const).map((side, index) => {
          const model = side === "total" ? undefined : window.estimated?.[side];
          const estimated = side === "total" && window.estimated
            ? window.estimated.long.notional + window.estimated.short.notional : model?.notional;
          const observed = side === "total" ? window.observed.long + window.observed.short : window.observed[side];
          const delta = estimated !== undefined && window.streamComplete ? estimated - observed : null;
          const low = model?.lowestPrice;
          const high = model?.highestPrice;
          return <tr key={side + window.time}>
            {index === 0 && <td rowSpan={3}>{windowStartTime.format(window.time)}–{windowEndTime.format(window.time + LIQUIDATION_INTERVAL_MS)}</td>}
            <td className={side === "long" ? styles.sell : side === "short" ? styles.buy : undefined}>{side === "total" ? "合计" : sideLabel[side]}</td>
            <td>{side === "total" ? "—" : price(side === "long" ? window.low : window.high)}</td>
            {index === 0 && <td rowSpan={3}>{window.snapshotTime === null ? "缺事前快照" : liveTime.format(window.snapshotTime)}</td>}
            <td>{low == null || high == null ? "—" : low === high ? price(low) : formatMarketPriceRange(low, high, price)}</td>
            <td>{estimated === undefined ? "—" : amount.format(estimated)}</td>
            <td>{amount.format(observed)}{!window.streamComplete && "（部分）"}</td>
            <td>{delta === null ? "—" : difference.format(delta)}</td>
            <td>{delta === null || observed === 0 ? "—" : differenceRate.format(delta / observed)}</td>
          </tr>;
        }))}</tbody>
      </table>
    </div> : <p>等待本次打开后的 5 分钟标记价 K 线收盘。</p>}
  </section>;
}

export default function CoinLiquidations({ symbol }: { symbol: string }) {
  const [data, setData] = useState<LiquidationLevels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windows, setWindows] = useState<LiveWindowComparison[]>([]);
  const [marksUnavailable, setMarksUnavailable] = useState(false);
  const [streamStatus, setStreamStatus] = useState<LiquidationStreamStatus>("connecting");

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ symbol });
    const step = LIQUIDATION_INTERVAL_MS;
    const boundary = (time: number) => Math.floor(time / step) * step;
    const firstWindow = boundary(Date.now());
    const snapshots = new Map<number, AvailableRiskSnapshot>();
    let periods: LiquidationStreamPeriod[] = [];
    const settled = new Map<number, LiveWindowEstimate>();
    const fills = new Map<number, { long: number; short: number; seen: Set<string> }>();
    let markTimer: ReturnType<typeof setTimeout>;
    setData(null);
    setError(null);
    setWindows([]);
    setMarksUnavailable(false);

    function publish() {
      setWindows([...settled.values()].sort((a, b) => b.time - a.time).map((window) => {
        const sums = fills.get(window.time);
        return { ...window, observed: { long: sums?.long ?? 0, short: sums?.short ?? 0 } };
      }));
    }

    const disconnect = subscribeBinanceLiquidations(symbol, (event) => {
      const bucket = boundary(event.time);
      if (bucket < Math.max(firstWindow, boundary(Date.now()) - LIVE_LIQUIDATION_WINDOW_LIMIT * step)) return;
      const sums = fills.get(bucket) ?? { long: 0, short: 0, seen: new Set<string>() };
      if (sums.seen.has(event.id)) return;
      sums.seen.add(event.id);
      sums[event.side] += event.notional;
      fills.set(bucket, sums);
      if (settled.has(bucket)) publish();
    }, (status) => {
      const now = Date.now();
      const previous = periods.at(-1);
      if (previous && previous.to === undefined) previous.to = now;
      if (status === "connected") periods.push({ from: now });
      setStreamStatus(status);
    });

    const markParams = new URLSearchParams({ symbol, closedMarks: "1" });
    async function settleWindows() {
      const close = boundary(Date.now());
      try {
        const response = await fetch(apiUrl("/api/markets/liquidations?" + markParams), { signal: request.signal, cache: "no-store" });
        const bars = await readMarketResponse<ClosedMarkBar[]>(response, "标记价 K 线暂不可用。");
        if (request.signal.aborted) return;
        const keepFrom = Math.max(firstWindow, close - LIVE_LIQUIDATION_WINDOW_LIMIT * step);
        for (const bar of bars) {
          if (bar.time < keepFrom || bar.time >= close || settled.has(bar.time)) continue;
          settled.set(bar.time, estimateLiveWindow(bar, snapshots.get(bar.time), periods));
          snapshots.delete(bar.time);
        }
        for (const key of settled.keys()) if (key < keepFrom) settled.delete(key);
        for (const key of fills.keys()) if (key < keepFrom) fills.delete(key);
        for (const key of snapshots.keys()) if (key < keepFrom) snapshots.delete(key);
        periods = periods.filter(({ to }) => to === undefined || to >= keepFrom);
        publish();
        setMarksUnavailable(!settled.has(close - step));
      } catch {
        if (!request.signal.aborted) setMarksUnavailable(true);
      } finally {
        if (!request.signal.aborted) {
          const now = Date.now();
          const delay = boundary(now) > close || !settled.has(close - step) ? 8_000 : close + step + 4_000 - now;
          markTimer = setTimeout(settleWindows, delay);
        }
      }
    }
    markTimer = setTimeout(settleWindows, boundary(Date.now()) + step + 4_000 - Date.now());

    async function refresh() {
      const unavailable = "强平风险图暂不可用，正在重试。";
      try {
        const response = await fetch(apiUrl(`/api/markets/liquidations?${params}`), { signal: request.signal, cache: "no-store" });
        const snapshot = await readMarketResponse<LiquidationLevels>(response, unavailable);
        if (request.signal.aborted) return;
        rememberLiveSnapshot(snapshots, { asOf: snapshot.asOf, receivedAt: Date.now(), triggers: snapshot.triggers });
        setData(snapshot);
        setError(null);
      } catch (error) {
        if (!request.signal.aborted) setError(error instanceof Error ? error.message : unavailable);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(refresh, LIQUIDATION_REFRESH_MS);
      }
    }
    void refresh();
    return () => {
      request.abort();
      clearTimeout(timer);
      clearTimeout(markTimer);
      disconnect();
    };
  }, [symbol]);

  const coverage = data?.coverage;
  return (
    <details className={`${styles.result} ${styles.turnover}`} open>
      <summary className={styles.researchSummary}><h4>多空强平风险图 <span>币安 · {symbol}</span></h4></summary>
      <p>如果标记价跌到某个区间，估计会触发强平的仓位占多头总量的 {weightPercent.format(LIQUIDATION_RISK_BAND_SHARES.high)} 至不足 {weightPercent.format(LIQUIDATION_RISK_BAND_SHARES.extreme)} 为高风险，
        达到 {weightPercent.format(LIQUIDATION_RISK_BAND_SHARES.extreme)} 为极高风险。标记价上涨时，空头按空头总量用同样的规则判断。
        占比达到 {weightPercent.format(LIQUIDATION_RISK_BAND_SHARES.elevated)}、不足 {weightPercent.format(LIQUIDATION_RISK_BAND_SHARES.high)} 为中风险，更低为低风险。</p>
      {error && <p role="status">{error}{data && " 以下为上次快照。"}</p>}
      {!data && !error && <p role="status">正在计算强平风险…</p>}
      {data && <>
        <p>当前参考价 <span title={fullMarketNumber.format(data.markPrice)}>{price(data.markPrice)}</span> USDT · 行情时间 {time.format(data.asOf)} · 持仓数据截至 {time.format(data.interestThrough)} · 持仓回看 {amount.format(data.lookbackMs / 3_600_000)} 小时</p>
        <p><strong>图中的仓位</strong> · {coverage && coverage.openInterestQuantity > 0
          ? <>占多头总量的 {displayCoverage(coverage.longQuantity, coverage.openInterestQuantity)} · 占空头总量的 {displayCoverage(coverage.shortQuantity, coverage.openInterestQuantity)}。</>
          : coverage ? "当前持仓总量为零。" : "暂无数据。"}</p>
        {coverage && <p><strong>图外的仓位</strong> · 多头 {formatMarketAmount(Math.max(0, coverage.openInterestQuantity - coverage.longQuantity))} 枚 · 空头 {formatMarketAmount(Math.max(0, coverage.openInterestQuantity - coverage.shortQuantity))} 枚。图中的仓位来自最近行情数据推算。</p>}
        <LiquidationChart data={data} />
        <details><summary>查看仓位模型参数</summary><LiquidationModelParameters weighting={data.leverageWeighting} /></details>
      </>}
      <LiveLiquidationPanel windows={windows} status={streamStatus} marksUnavailable={marksUnavailable} />
    </details>
  );
}
