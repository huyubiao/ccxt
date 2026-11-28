import { useEffect, useRef, useState } from "react";
import { SPIKE_RECORD_LIMIT, spikeStatusLabels, type AlertHistoryRow } from "@/lib/alert-history";
import { apiUrl } from "@/lib/basePath";
import type { BreakoutObservation, ContinuationResult } from "@/lib/background-monitor-types";
import { formatAlertTurnover, formatMarketAmount, formatMarketPriceRange, marketNumberFormatter } from "@/lib/market-number";
import { alertDayStart, spikeKey, type SpikeIdentity } from "@/lib/price-alerts";
import type { Trade } from "@/lib/trading-types";
import { useRecordSelection } from "./use-record-selection";
import { useRememberedDetails } from "./use-remembered-details";
import styles from "./markets.module.css";

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const formatPrice = marketNumberFormatter({ maximumSignificantDigits: 12 });
const formatChange = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const formatThreshold = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatScorePercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const continuationLabels: Record<ContinuationResult["status"], string> = {
  pending: "待评分", submitting: "正在下单", ordered: "已开仓", "below-score": "未达下单分数",
  disabled: "已达标，自动下单关闭", "no-account": "已达标，未连接交易账号", unavailable: "历史行情不足或获取失败",
  "observation-unavailable": "突破观察不可用，跳过下单", "breakout-lost": "突破失守，跳过下单",
  "queue-skipped": "评分队列已满", interrupted: "评估已中断或过期", unknown: "下单结果待核对", failed: "自动下单失败",
  "flow-unavailable": "告警区间成交不可用，跳过下单", evaluated: "升级评分达标",
};
const sideLabels = { long: "多头", short: "空头" };
const observationLabels = {
  pending: "等待观察", "queue-skipped": "观察队列已满", "no-trades": "观察窗口内无成交",
  unavailable: "成交数据不可用", interrupted: "观察已中断",
};
const breakoutLabels = {
  held: "突破后站稳", recovered: "回吐后收复", retained: "回吐未失守",
  half: "回吐一半", endangered: "回吐即将失守", lost: "失守",
};

const protectionFailurePrefix = "自动保护单设置失败：";
const binanceFailureReasons: Record<string, string> = {
  "-2015": "币安拒绝了 API 密钥、IP 地址或交易权限",
  "-2018": "账户余额不足",
  "-2019": "可用保证金不足",
  "-2021": "提交时已经满足订单的触发条件，币安拒绝挂单",
  "-2022": "币安拒绝了只减仓订单，可能与现有挂单冲突",
  "-4131": "对手方最优价超出币安允许的价格范围，市价单被拒",
  "-4142": "提交时已经满足订单的触发条件，币安拒绝挂单",
  "-4164": "订单金额低于币安要求的最小名义价值",
};

function failureReason(error: string, protection = false) {
  const separator = error.lastIndexOf("：");
  const detail = error.slice(separator + 1).trim();
  const match = detail.match(/(?:[（(](-\d+)[）)]|^(-\d+))$/);
  const code = match?.[1] ?? match?.[2];
  if (!code) return error;
  const reason = protection && (code === "-2021" || code === "-4142")
    ? "提交时标记价已满足触发条件，币安拒绝挂单"
    : binanceFailureReasons[code] ?? (match?.[2] ? `币安返回错误码 ${code}，具体原因待核对` : undefined);
  return reason ? error.slice(0, separator + 1) + reason : error;
}

function continuationFailure(row: AlertHistoryRow, trades: readonly Trade[]) {
  const result = row.continuation;
  const error = result?.error?.trim();
  if (!result || !error) return;
  const label = continuationLabels[result.status];
  if (!error.startsWith(protectionFailurePrefix)) return { label, reason: failureReason(error) };

  const raw = error.slice(protectionFailurePrefix.length);
  // Older alerts have a round ID but did not save the failed order's kind or price.
  for (const trade of trades) {
    if (trade.strategy.id !== "market-spike" || trade.symbol !== row.symbol || trade.side !== result.side ||
      (result.tradeId ? trade.id !== result.tradeId : !row.roundId || trade.roundId !== row.roundId)) continue;
    const failureIndex = trade.orders.findIndex((order) => (order.kind === "stop-loss" || order.kind === "take-profit") &&
      order.error && raw.endsWith(order.error));
    const order = trade.orders[failureIndex];
    if (!order?.error) continue;
    const name = order.kind === "stop-loss" ? "止损" : "止盈";
    const price = order.triggerPrice == null ? "" : `触发价 ${formatPrice(order.triggerPrice)}，`;
    const exits = trade.orders.slice(failureIndex + 1).filter(({ kind }) => kind === "exit");
    const rejected = exits.filter(({ status, error }) => status === "failed" && error);
    const lastError = rejected.at(-1)?.error;
    const exit = exits.findLast(({ status }) => status === "filled");
    const closed = exit && (trade.status === "closed" || (trade.status === "failed" && trade.closedAt != null));
    const followUp = closed
      ? `已市价平仓${trade.exitPrice == null ? "" : `，成交均价 ${formatPrice(trade.exitPrice)}`}`
      : trade.status === "closing" ? "市价平仓处理中" : undefined;
    const retries = lastError && `市价平仓有 ${rejected.length} 次被拒，最近一次原因是${failureReason(lastError)}`;
    return { label: `开仓已成交 · ${name}挂单失败`, reason: price + failureReason(order.error, true), followUp, retries };
  }
  return { label: "自动保护单设置失败", reason: failureReason(raw, true) };
}

function BreakoutDetails({ observation }: { observation: BreakoutObservation }) {
  if (observation.status !== "ready") return <div>突破后走势 · {observationLabels[observation.status]}</div>;
  const { windowSeconds, buyUsdt, sellUsdt, netPercent, position, targetPrice, lastPrice, lastTradeTime } = observation;
  const buyShare = (100 + netPercent) / 2;
  return <>
    <div title={`主动买入 ${formatMarketAmount(buyUsdt)} USDT，主动卖出 ${formatMarketAmount(sellUsdt)} USDT`}>
      触发后 {windowSeconds} 秒主动成交 · 买入 {formatScorePercent.format(buyShare)}% · 卖出 {formatScorePercent.format((100 - netPercent) / 2)}%
    </div>
    <div title={`窗口内最后一笔成交时间 ${formatTime.format(lastTradeTime)}`}>
      突破后走势 · {breakoutLabels[position]}（门槛价 {formatPrice(targetPrice)}，最后成交价 {formatPrice(lastPrice)}）
    </div>
    {observation.referencePrice !== undefined && <div>参考价 {formatPrice(observation.referencePrice)}
      {observation.worstPrice !== undefined && `，5 秒内最不利成交价 ${formatPrice(observation.worstPrice)}`}</div>}
  </>;
}

function ContinuationCell({ row, trades }: { row: AlertHistoryRow; trades: readonly Trade[] }) {
  const { continuation: result, breakoutObservation: observation } = row;
  const failure = continuationFailure(row, trades);
  const label = failure?.label ?? (result ? continuationLabels[result.status] : "走势观察");
  const { score, side, target, error } = result ?? {};
  if (!score && !observation && !failure) return result ? label : "—";
  return <details className={styles.alertContinuation}>
    <summary>{score && `${score.total} 分 · ${side === "long" ? "做多" : "做空"} · `}{label}
      {failure && <span className={styles.alertFailureReason}>{failure.reason}</span>}
    </summary>
    {failure?.followUp && <div>{failure.followUp}</div>}
    {failure?.retries && <div>{failure.retries}</div>}
    {error && error !== failure?.reason && <div>原始错误 · {error}</div>}
    {observation && <BreakoutDetails observation={observation} />}
    {score && ("breakoutPoints" in score ? <>
      <div>走势评估 {score.breakoutPoints}/35</div>
      <div>{score.flow ? "同向主动成交 + 订单簿深度" : "同向主动成交"} {score.flowPoints}/35</div>
      {score.flow && <>
        <div>完整告警区间 {formatTime.format(score.flow.start)} 至 {formatTime.format(score.flow.end)}</div>
        <div>同向主动{side === "long" ? "买入" : "卖出"} {formatScorePercent.format(score.flow.alignedPercent)}% · {score.flow.activePoints} 分
          （主动买入 {formatMarketAmount(score.flow.buyUsdt)} USDT，主动卖出 {formatMarketAmount(score.flow.sellUsdt)} USDT）</div>
        <div>订单簿深度补充 {score.flow.depthPoints}/{score.flow.depthMaxPoints ?? 20}{score.flow.depth && score.flow.depthPercent !== null
          ? `（${side === "long" ? "买" : "卖"}挂单占比 ${formatScorePercent.format(score.flow.depthPercent)}%）`
          : "（快照不可用，补充分数为 0）"}</div>
        {score.flow.depth && <div>盘口快照 {formatTime.format(score.flow.depth.time)} · 买盘 {score.flow.depth.bidLevels} 档 {formatMarketAmount(score.flow.depth.bidUsdt)} USDT
          · 卖盘 {score.flow.depth.askLevels} 档 {formatMarketAmount(score.flow.depth.askUsdt)} USDT</div>}
        <div>两项合计封顶 35 分</div>
      </>}
      {score.turnoverBonus ? <>
        <div>告警成交额额外加分 +{score.turnoverPoints}/20（{score.turnoverBonus.first ? "首报成交额倍数" : "本次区间成交额 / 上次告警成交额"}
          {score.turnoverBonus.multiple === null ? "不可用" : ` ${formatScorePercent.format(score.turnoverBonus.multiple)} 倍`}）</div>
        {score.turnoverBonus.currentTurnover != null && <div>本次成交额 {formatMarketAmount(score.turnoverBonus.currentTurnover)} USDT
          · {score.turnoverBonus.first ? "基准成交额" : "上次告警成交额"} {score.turnoverBonus.previousTurnover == null
            ? "不可用" : `${formatMarketAmount(score.turnoverBonus.previousTurnover)} USDT`}</div>}
        <div>异动前横盘平静度 {score.pricePoints}/30 · 沿用本轮首报</div>
        {score.quietness ? <>
          <div>首报前回看区间 {formatTime.format(score.quietness.start)} 至 {formatTime.format(score.quietness.end)}</div>
          <div>整体振幅 {formatScorePercent.format(score.quietness.rangePercent)}% · {score.quietness.rangePoints}/10</div>
          <div>前后平均价偏移 {formatScorePercent.format(score.quietness.driftPercent)}% · {score.quietness.driftPoints}/10</div>
          <div>最大单根振幅 {formatScorePercent.format(score.quietness.maxCandlePercent)}% · {score.quietness.candlePoints}/10</div>
        </> : <div>首报历史数据不足或获取失败，平静度计 0 分</div>}
      </> : <>
        <div>成交额 {score.turnoverPoints}/20</div>
        <div>历史振幅 {score.pricePoints}/10{score.rangePercent === null ? "（历史数据不足）" : `（${formatScorePercent.format(score.rangePercent)}%）`}</div>
      </>}
      <div><a href="#coin-research">在币种深度调研查看强平估算</a></div>
    </> : <>
      <div>涨跌幅 {score.pricePoints}/60{score.rangePercent !== null && `（振幅 ${formatScorePercent.format(score.rangePercent)}%）`}</div>
      <div>成交额 {score.turnoverPoints}/30</div>
      <div>强平 {score.liquidationPoints}/10{score.nearSharePercent === null ? "（缺少估算）" :
        `（${score.dominantSide ? `${sideLabels[score.dominantSide]}占优` : "多空持平"}，同向近价占比 ${formatScorePercent.format(score.nearSharePercent)}%）`}</div>
    </>)}
    {score && <div>下单门槛 {target} 分</div>}
  </details>;
}

function dayKey({ symbol, time }: AlertHistoryRow) {
  return JSON.stringify([alertDayStart(time), symbol]);
}

export default function AlertRecords({ records, trades = [], canDelete, onDelete }: {
  records: readonly AlertHistoryRow[];
  trades?: readonly Trade[];
  canDelete: boolean;
  onDelete: (records: readonly SpikeIdentity[]) => Promise<void>;
}) {
  const details = useRememberedDetails("alert-records");
  const { selected, count, deleting, error, deletedCount, allSelected, partlySelected, select, selectAll, deleteSelected } =
    useRecordSelection(records, spikeKey, {
      label: "告警记录", canDelete, onDelete: (rows) => onDelete(rows.map(({ symbol, time, threshold }) => ({ symbol, time, threshold }))),
    });
  const cache = useRef(new Map<string, number>());
  const [opens, setOpens] = useState<ReadonlyMap<string, number>>(new Map());
  const keys = JSON.stringify([...new Set(records.map(dayKey))].sort().reverse());

  useEffect(() => {
    if (!details.open) return;
    const controller = new AbortController();
    const current = cache.current;
    const targets = JSON.parse(keys) as string[];
    const pending = targets.filter((key) => !current.has(key));
    if (current.size + pending.length > 2 * SPIKE_RECORD_LIMIT) {
      const retained = new Set(targets);
      for (const key of current.keys()) {
        if (!retained.has(key)) current.delete(key);
      }
    }
    async function load() {
      while (!controller.signal.aborted && pending.length) {
        const key = pending.shift()!;
        const [day, symbol] = JSON.parse(key) as [number, string];
        const params = new URLSearchParams({ symbol, time: String(day), view: "day-open" });
        try {
          const response = await fetch(apiUrl(`/api/markets/alert-context?${params}`), {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          });
          if (!response.ok) continue;
          const { open } = await response.json();
          if (!controller.signal.aborted && typeof open === "number" && Number.isFinite(open) && open > 0) {
            current.set(key, open);
            setOpens(new Map(current));
          }
        } catch { /* Leave the daily change unavailable if the request fails. */ }
      }
    }
    void load();
    void load();
    return () => controller.abort();
  }, [details.open, keys]);

  return (
    <details className={styles.turnover} {...details}>
      <summary className={styles.monitorSectionSummary}>
        <h4>告警记录 <span>最近 {SPIKE_RECORD_LIMIT} 条</span></h4>
      </summary>
      {records.length > 0 && (
        <div className={styles.alertActions}>
          <span>已选 {count} 条</span>
          <button type="button" disabled={!canDelete || deleting || !count} onClick={() => void deleteSelected()}>
            {deleting ? "正在删除…" : "删除选中记录"}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {deletedCount > 0 && <p role="status">已删除 {deletedCount} 条告警记录。</p>}
      <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
        <table className={styles.alertTable}>
          <thead><tr>
            <th scope="col">
              <label className={styles.alertSelectAll}>
                <input type="checkbox" checked={allSelected} disabled={deleting || records.length === 0}
                  aria-label="全选当前显示的告警记录"
                  ref={(input) => { if (input) input.indeterminate = partlySelected; }}
                  onChange={(event) => selectAll(event.currentTarget.checked)} />
                全选
              </label>
            </th>
            <th scope="col">交易对</th><th scope="col">告警级别</th><th scope="col">触发时间</th>
            <th scope="col">参考价/触发价 (USDT)</th>
            <th scope="col" title="按北京时间当日开盘价到触发价计算">当日涨跌幅度</th>
            <th scope="col">涨跌幅 / 触发阈值</th><th scope="col">监控窗口</th>
            <th scope="col">成交额 (USDT)</th><th scope="col">核验结果</th><th scope="col">延续评分与下单</th>
          </tr></thead>
          <tbody>
            {records.length === 0 && (
              <tr><td colSpan={11} className={styles.emptyTableCell}><span role="status">暂无告警记录。</span></td></tr>
            )}
            {records.map((row) => {
              const key = spikeKey(row);
              const triggerTime = formatTime.format(row.time);
              const open = opens.get(dayKey(row));
              const change = open === undefined ? NaN : (row.price - open) / open * 100;
              const dailyChange = Number.isFinite(change) ? change : null;
              return <tr key={key}>
                <td>
                  <input type="checkbox" checked={selected.has(key)} disabled={deleting}
                    aria-label={`选择 ${row.symbol} ${triggerTime} ${row.threshold > 0 ? "上涨" : "下跌"}告警`}
                    onChange={(event) => select(key, event.target.checked)} />
                </td>
                <th scope="row">{row.symbol}</th>
                <td>{row.level} 级</td>
                <td><time dateTime={new Date(row.time).toISOString()}>{triggerTime}</time></td>
                <td>
                  {formatMarketPriceRange(row.previous, row.price, formatPrice, " / ")}
                  {row.originalReference !== undefined && row.originalReference !== row.previous &&
                    <div>原始参考价 {formatPrice(row.originalReference)}</div>}
                </td>
                <td className={dailyChange === null || dailyChange === 0 ? undefined : dailyChange < 0 ? styles.sell : styles.buy}>
                  {dailyChange === null ? "—" : `${formatChange.format(dailyChange)}%`}
                </td>
                <td><span className={row.change < 0 ? styles.sell : styles.buy}>{formatChange.format(row.change)}%</span>
                  {" / "}{formatThreshold.format(row.threshold)}%</td>
                <td>{row.observationMinutes !== undefined ? `${row.observationMinutes} 分钟观察` : `${row.seconds} 秒`}</td>
                <td>{formatAlertTurnover(row.volume, row.legacyMultiple) ?? formatMarketAmount(row.volume?.turnover)}</td>
                <td title={row.requiredMultiple === null ? undefined : `成交额门槛 ${row.requiredMultiple} 倍`}>
                  {spikeStatusLabels[row.status]}
                </td>
                <td><ContinuationCell row={row} trades={trades} /></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
