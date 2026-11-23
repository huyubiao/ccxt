"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { LiquidationBacktest } from "@/lib/liquidation-backtest";
import { formatMarketAmount, formatMarketPriceRange, marketNumberFormatter } from "@/lib/market-number";
import { readMarketResponse } from "@/lib/market-response";
import styles from "./markets.module.css";

const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const percentage = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const price = marketNumberFormatter({ maximumSignificantDigits: 10 });
const sourceStatus = { covered: "完整覆盖", partial: "部分覆盖", unavailable: "不可用" };
const sideNames = { long: "多头", short: "空头" };

function Results({ result }: { result: LiquidationBacktest }) {
  const [source, setSource] = useState(() => result.references.find(({ status }) => status === "covered")?.source ??
    result.references.find(({ status }) => status === "partial")?.source ?? result.references[0].source);
  const [side, setSide] = useState<keyof typeof sideNames>("long");
  const [index, setIndex] = useState(result.windows.length - 1);
  const reference = result.references.find((row) => row.source === source) ?? result.references[0];
  const report = reference.comparison?.find((row) => row.side === side);
  const scores = reference.falseAlerts.find((row) => row.side === side)!;
  const byTime = new Map(report?.timeline.map((event) => [event.time, event]));
  const window = result.windows[index];
  const observed = reference.observations[index];
  const event = byTime.get(window.time);
  const bands = window.snapshot?.bands.filter((band) => band.side === side);
  const states = { hit: "命中", miss: "未命中", unknown: "无法核对" };

  return <>
    <p>{time.format(result.from)} 至 {time.format(result.to)} · 每 5 分钟一窗 · 提前 {result.leadMinutes} 分钟生成风险价带</p>
    {result.modelError && <p role="status">{result.modelError}</p>}
    <div className={styles.marketControls}>
      <label>参考数据源 <select value={source} onChange={(change) => setSource(change.target.value as typeof source)}>
        {result.references.map((row) => <option key={row.source} value={row.source}>{row.source} · {sourceStatus[row.status]}</option>)}
      </select></label>
      <label>强平方向 <select value={side} onChange={(change) => setSide(change.target.value as typeof side)}>
        <option value="long">多头</option><option value="short">空头</option>
      </select></label>
    </div>
    <p>{reference.detail}</p>
    <dl className={styles.backtestMetrics}>
      <div><dt>价带命中率</dt><dd>{report?.hitRate != null ? `${percentage.format(report.hitRate)}（${report.hits}/${report.hits + report.misses}）` : "—"}</dd></div>
      <div><dt>价带触达误报率</dt><dd>{scores.negatives ? `${percentage.format(scores.falsePositives / scores.negatives)}（${scores.falsePositives}/${scores.negatives}）` : "—"}</dd></div>
      <div><dt>参考源覆盖率</dt><dd>{percentage.format(reference.coveredWindows / result.windows.length)}（{reference.coveredWindows}/{result.windows.length}）</dd></div>
      <div><dt>风险快照</dt><dd>{result.snapshotCount}/{result.windows.length} 窗</dd></div>
    </dl>
    <p>{report && <>已记录 {report.events} 次达到 {formatMarketAmount(result.eventNotional)} 的强平事件，其中 {report.unknown} 次无法核对价带。 </>}
      误报率按有覆盖且强平额低于阈值的窗口计算，标记价触及高风险或极高风险价带计为误报。</p>
    <div className={styles.backtestTimeline} aria-hidden="true">
      {result.windows.map(({ time, touched }, position) => {
        const row = reference.observations[position];
        const comparison = byTime.get(time);
        const status = comparison?.result ?? (!row.covered ? "gap" : touched?.[side] ? "touch" : "covered");
        return <span key={time} data-status={status} data-active={position === index} onClick={() => setIndex(position)} />;
      })}
    </div>
    <p className={styles.backtestLegend}>
      <span data-status="covered">已覆盖</span><span data-status="gap">覆盖缺口</span><span data-status="hit">命中</span>
      <span data-status="miss">未命中／误报</span><span data-status="unknown">事件无法核对</span>
    </p>
    <label className={styles.backtestSlider}>
      选择窗口 <input type="range" aria-valuetext={time.format(window.time)} min="0" max={result.windows.length - 1}
        value={index} onChange={(change) => setIndex(Number(change.target.value))} />
      <strong>{time.format(window.time)}</strong>
    </label>
    <p>标记价范围 {window.mark ? formatMarketPriceRange(window.mark.low, window.mark.high, price) : "—"} USDT
      · {sideNames[side]}强平 {observed[side] == null ? "数据缺失" : formatMarketAmount(observed[side])}
      {observed[side] != null && !observed.covered && "（部分记录）"}{event && ` · ${states[event.result]}`}</p>
    {event?.prices && <p>强平成交价范围 {formatMarketPriceRange(event.prices.low, event.prices.high, price)} USDT</p>}
    {bands?.length ? <ul className={styles.backtestBands}>
      {bands.map((band) => <li key={band.lowerPrice}>{formatMarketPriceRange(band.lowerPrice, band.upperPrice, price)} USDT
        · {band.riskLevel === "extreme" ? "极高风险" : "高风险"} · 持仓占比 {percentage.format(band.openInterestShare)}</li>)}
    </ul> : <p>{window.snapshot ? "该方向没有高风险价带。" : "该窗口缺少风险快照。"}</p>}
  </>;
}

export default function LiquidationBacktestPanel({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LiquidationBacktest | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || result) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ symbol });
    const unavailable = "强平价带回测暂不可用。";
    void fetch(apiUrl(`/api/markets/liquidations/backtest?${params}`), { cache: "no-store", signal: controller.signal })
      .then((response) => readMarketResponse<LiquidationBacktest>(response, unavailable))
      .then((data) => { if (!controller.signal.aborted) setResult(data); })
      .catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : unavailable); });
    return () => controller.abort();
  }, [open, symbol, revision, result]);

  return <details className={styles.liquidationBacktest} onToggle={(change) => setOpen(change.currentTarget.open)}>
    <summary>历史强平回测</summary>
    {open && <div>
      {error ? <p role="alert">{error}</p> : result ? <Results result={result} /> : <p role="status">正在回放最近 24 小时数据…</p>}
      {(error || result) && <button type="button" onClick={() => {
        setError("");
        setResult(null);
        setRevision(revision + 1);
      }}>{error ? "重试" : "刷新回测"}</button>}
    </div>}
  </details>;
}
