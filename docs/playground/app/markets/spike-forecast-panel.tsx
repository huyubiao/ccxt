import { formatMarketAmount, marketNumberFormatter } from "@/lib/market-number";
import {
  compareForecast, forecastAccuracy, largeTradeSide,
  type ForecastIndicators, type ForecastRecord,
} from "@/lib/spike-forecast";
import styles from "./markets.module.css";

const signed = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const price = marketNumberFormatter({ maximumSignificantDigits: 10 });
const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
const flowLabels = { buy: "疑似大额主动买入", sell: "疑似大额主动卖出", mixed: "双向大额主动成交", none: "未观察到大额主动成交" };

function signal(change: number) {
  const direction = change > 0 ? "涨" : change < 0 ? "跌" : "持平";
  return `${direction} ${signed.format(change)}%`;
}

function NotionalPair({ left, right }: { left: number; right: number }) {
  return <>{formatMarketAmount(left)} / {formatMarketAmount(right)} USDT</>;
}

function Indicators({ indicators }: { indicators: ForecastIndicators }) {
  const { flow, depth, interest, liquidations, holders } = indicators;
  return <details className={styles.forecastIndicators}>
    <summary>{flow ? flowLabels[largeTradeSide(flow)] : "主动成交数据不足"}</summary>
    <dl>
      <dt>近 60 秒主动买入 / 卖出</dt><dd>{flow ? <NotionalPair left={flow.buyUsdt} right={flow.sellUsdt} /> : "—"}</dd>
      <dt>大额主动买入 / 卖出</dt><dd>{flow ? <><NotionalPair left={flow.largeBuyUsdt} right={flow.largeSellUsdt} />
        <small>大额门槛 {formatMarketAmount(flow.largeThresholdUsdt)} USDT</small></> : "—"}</dd>
      <dt>中间价 ±0.5% 买盘 / 卖盘深度</dt><dd>{depth ? <NotionalPair left={depth.bidUsdt} right={depth.askUsdt} /> : "—"}</dd>
      <dt>最近 5 分钟未平仓数量变化</dt><dd>{interest ? `${signed.format(interest.change)}%` : "—"}</dd>
      <dt>标记价 ±2% 多头 / 空头强平估算</dt><dd>{liquidations ? <NotionalPair left={liquidations.longUsdt} right={liquidations.shortUsdt} /> : "—"}</dd>
      <dt>前列地址持币量占最大供应量</dt><dd>{holders ? `${number.format(holders.percentage)}%（${holders.count} 个地址）` : "—"}</dd>
    </dl>
  </details>;
}

export default function SpikeForecastPanel({ records }: { records: ForecastRecord[] }) {
  const { samples, hits, mae } = forecastAccuracy(records);
  return <details className={styles.turnover}>
    <summary className={styles.monitorSectionSummary}><h4>涨跌预测 <span>最近 100 条告警样本</span></h4></summary>
    <p role="status">{mae !== null
      ? `方向准确率 ${number.format(hits / samples * 100)}%（${samples} 条中对了 ${hits} 条） · 预测涨跌幅平均差 ${number.format(mae)} 个百分点`
      : "核对完第一条预测后，这里会显示方向准确率和涨跌幅平均差多少。"}</p>
    {records.length > 0 && <div className={`${styles.tableScroll} ${styles.alertScroll}`} tabIndex={0} role="region" aria-label="预测与实际涨跌对比">
      <table className={`${styles.alertTable} ${styles.forecastTable}`}>
        <thead><tr>
          <th scope="col">交易对 / 告警时间</th><th scope="col">预测方向 / 幅度</th><th scope="col">核对时间</th>
          <th scope="col">实际方向 / 幅度</th><th scope="col">预测结果</th><th scope="col">指标与大额成交</th>
        </tr></thead>
        <tbody>{records.map((record) => {
          const { symbol, time: alertedAt, analysis, outcome } = record;
          const forecast = analysis?.forecast;
          const forecastStatus = analysis === undefined ? "正在采集指标" : analysis === null ? "综合行情暂不可用" : "综合信号或基准价不足";
          const compared = forecast && outcome ? compareForecast(forecast, outcome) : null;
          return <tr key={`${symbol}:${alertedAt}`}>
            <th scope="row">{symbol}<small>{time.format(alertedAt)}</small></th>
            <td>{forecast ? <>
              <span className={forecast.change > 0 ? styles.buy : styles.sell}>{signal(forecast.change)}</span>
              <small>基准 {price(forecast.price)} USDT · {time.format(forecast.issuedAt)}</small>
            </> : forecastStatus}</td>
            <td>{forecast ? time.format(forecast.settlesAt) : "—"}</td>
            <td>{compared && outcome ? <>{signal(compared.actual)}<small>收盘 {price(outcome.price)} USDT</small></>
              : forecast ? outcome === null ? "缺少核对时的收盘价" : "待核对" : "—"}</td>
            <td>{compared ? <>{compared.hit ? "方向命中" : "方向未命中"}
              <small>误差 {number.format(compared.error)} 个百分点</small></> : "—"}</td>
            <td>{analysis ? <Indicators indicators={analysis.indicators} /> : analysis === undefined ? "采集指标中…" : "指标暂不可用"}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <details className={styles.forecastNotes}>
      <summary>怎么看预测结果？</summary>
      <p><strong>预测什么？</strong> 告警后，系统结合主动成交、挂单等指标估计接下来约 5 分钟的涨跌方向和幅度。信号不足或行情暂不可用时，预测列会显示对应状态。</p>
      <p><strong>怎么核对？</strong> 从预测时的价格算起，满 5 分钟后，取到达的第一个整分钟的收盘价来算实际涨跌。比如 10:02:20 给出预测，就用 10:08 的收盘价核对。</p>
      <p><strong>怎么算准不准？</strong> 比如预测涨 2%，实际涨 1%，方向算对，幅度差 1 个百分点。如果实际下跌或持平，方向算错。方向准确率和平均幅度差都只统计已经核对过的预测。</p>
    </details>
  </details>;
}
