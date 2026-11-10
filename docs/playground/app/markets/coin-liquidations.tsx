"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { groupLiquidationTable, LIQUIDATION_REFRESH_MS, type LiquidationBand, type LiquidationLevels } from "@/lib/liquidation-levels";
import type { LiquidationBacktest } from "@/lib/liquidation-backtest";
import styles from "./markets.module.css";

const price = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 8 });
const percent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const amount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const weightPercent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const compactAmount = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumSignificantDigits: 3 });
const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
const backtestTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Shanghai" });
const signedAmount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, signDisplay: "exceptZero" });

type ChartMode = "interval" | "cumulative";


function displayAmount(value: number) {
  return value > 0 && value < 0.01 ? "<0.01" : amount.format(value);
}

function LiquidationChart({ data, mode }: { data: LiquidationLevels; mode: ChartMode }) {
  const sorted = [...data.levels].sort((a, b) => a.lowerPrice - b.lowerPrice);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return <p>本次快照暂无可绘制的估算区间。</p>;

  const minimum = Math.min(data.markPrice, first.lowerPrice);
  const maximum = Math.max(data.markPrice, last.upperPrice);
  const cumulative = mode === "cumulative";
  const maxAmount = Math.max(...sorted.map((band) => cumulative
    ? band.cumulativeEstimatedLiquidationUsdt : band.estimatedLiquidationUsdt));
  const left = 78, right = 755, top = 22, bottom = 190;
  const x = (value: number) => left + (value - minimum) / (maximum - minimum) * (right - left);
  const y = (value: number) => bottom - value / maxAmount * (bottom - top);
  const mark = x(data.markPrice);

  return (
    <figure className={styles.liquidationChart}>
      <figcaption>
        <span className={styles.sell}>多头强平 · 卖出</span>
        <span className={styles.buy}>空头强平 · 买入</span>
        <span>虚线 · 当前标记价</span>
      </figcaption>
      <div className={styles.tableScroll}>
        <svg viewBox="0 0 790 240" role="img" aria-label={cumulative ? "到各价位的累计预计清算金额" : "各价格区间的预计清算金额"}>
          <text x={left} y="13">预计金额 (USDT)</text>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const level = maxAmount * ratio;
            return <g key={ratio}>
              <line className={styles.liquidationGridline} x1={left} x2={right} y1={y(level)} y2={y(level)} />
              <text x={left - 8} y={y(level) + 4} textAnchor="end">{compactAmount.format(level)}</text>
            </g>;
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const value = minimum + (maximum - minimum) * ratio;
            return <text key={ratio} x={x(value)} y={bottom + 18} textAnchor="middle">{price.format(value)}</text>;
          })}
          <text x={(left + right) / 2} y={bottom + 39} textAnchor="middle">标记价 (USDT)</text>
          <line className={styles.liquidationMark} x1={mark} x2={mark} y1={top} y2={bottom} />
          {cumulative ? (["long", "short"] as const).map((side) => {
            const bands = sorted.filter((band) => band.side === side);
            if (side === "long") bands.reverse();
            const steps = bands.map((band) => `H ${x(side === "long" ? band.lowerPrice : band.upperPrice)} V ${y(band.cumulativeEstimatedLiquidationUsdt)}`);
            return <path key={side} className={side === "long" ? styles.sell : styles.buy}
              d={`M ${mark} ${bottom} ${steps.join(" ")} H ${side === "long" ? left : right}`}
              fill="none" stroke="currentColor" strokeWidth="2" />;
          }) : null}
          {sorted.map((band) => {
            const barTop = cumulative ? top : y(band.estimatedLiquidationUsdt);
            return <rect key={band.lowerPrice} className={band.side === "long" ? styles.sell : styles.buy}
              x={x(band.lowerPrice)} y={barTop} width={x(band.upperPrice) - x(band.lowerPrice)}
              height={bottom - barTop} fill={cumulative ? "transparent" : "currentColor"}>
              <title>{`${price.format(band.lowerPrice)}–${price.format(band.upperPrice)} · ${band.side === "long" ? "多头" : "空头"}\n区间 ${displayAmount(band.estimatedLiquidationUsdt)} USDT · 累计 ${displayAmount(band.cumulativeEstimatedLiquidationUsdt)} USDT`}</title>
            </rect>;
          })}
        </svg>
      </div>
    </figure>
  );
}

function Levels({ title, data, side }: { title: string; data: LiquidationLevels; side: LiquidationBand["side"] }) {
  const bands = groupLiquidationTable(data.levels, data.markPrice, side);
  return (
    <div>
      <h5>{title}</h5>
      <p>按涨跌幅合并为 {bands.length} 个价带。区间金额为 0 表示该价带暂无模型估算金额。</p>
      <p>{side === "long" ? "例如 −95% 表示标记价跌到现在的 5%。" : "例如 +500% 表示标记价涨到现在的 6 倍。"}远端价带按展示范围列出，只有模型算出的清算价落进去，才会计入金额。</p>
      <div className={`${styles.tableScroll} ${styles.liquidationScroll}`} tabIndex={0} role="region" aria-label={title}>
        <table aria-label={title}>
          <thead><tr><th scope="col" aria-sort={side === "long" ? "ascending" : "descending"}>价格区间 (USDT)</th>
            <th scope="col">到该区间约需涨跌</th><th scope="col">区间金额 (USDT)</th><th scope="col">累计金额 (USDT)</th></tr></thead>
          <tbody>{bands.map((band) => (
            <tr key={band.lowerDistance}>
              <th scope="row">{price.format(band.lowerPrice)} – {price.format(band.upperPrice)}</th>
              <td>{percent.format(band.lowerDistance)}% 至 {percent.format(band.upperDistance)}%</td>
              <td>{displayAmount(band.estimatedLiquidationUsdt)}</td>
              <td>{displayAmount(band.cumulativeEstimatedLiquidationUsdt)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Backtest({ symbol }: { symbol: string }) {
  const activeRequest = useRef<AbortController | null>(null);
  const [data, setData] = useState<LiquidationBacktest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function run() {
    if (activeRequest.current) return;
    const request = new AbortController();
    activeRequest.current = request;
    setBusy(true);
    setError(false);
    setData(null);
    try {
      const response = await fetch(apiUrl(`/api/markets/liquidations/backtest?${new URLSearchParams({ symbol })}`), {
        signal: request.signal, cache: "no-store",
      });
      if (!response.ok) throw new Error("Liquidation backtest unavailable.");
      const result: LiquidationBacktest = await response.json();
      if (!request.signal.aborted) setData(result);
    } catch {
      if (!request.signal.aborted) setError(true);
    } finally {
      activeRequest.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  const showAmount = (value?: number) => value === undefined ? "—" : displayAmount(value);
  const showModelAmount = (value?: number) => value === 0 ? "未触及估算强平位" : showAmount(value);
  return <div aria-busy={busy}>
    <button type="button" className={styles.holderButton} onClick={() => void run()} disabled={busy}>
      {busy ? "正在回测…" : "回测过去 24 小时"}
    </button>
    {error && <p role="status">回测暂不可用，请重试。</p>}
    {data && <>
      <p>北京时间 {backtestTime.format(data.from)} 至 {backtestTime.format(data.to)} · 按已完成的 5 分钟数据回放。</p>
      {data.modelError && <p role="status">{data.modelError}</p>}
      {data.model && (["long", "short"] as const).some((side) => data.model?.[side] === 0 &&
        data.references.some(({ amounts }) => (amounts?.[side] ?? 0) > 0)) &&
        <p role="status">平台在模型未触及的一侧收录了强平记录，当前模型存在漏估。</p>}
      {data.model && <p>{data.model.marginProfile
        ? `使用币安当前小额仓位档位。最高 ${data.model.marginProfile.maxLeverage} 倍，维持保证金率 ${weightPercent.format(data.model.marginProfile.maintenanceRate)}。`
        : "暂未取得币安档位，使用备用杠杆假设。"}</p>}
      <div className={styles.tableScroll}>
        <table aria-label="过去 24 小时强平回测">
          <thead><tr><th scope="col">来源</th><th scope="col">多头</th><th scope="col">空头</th><th scope="col">总金额</th>
            <th scope="col">模型与平台差值</th><th scope="col">相对平台差幅</th></tr></thead>
          <tbody>
            <tr><th scope="row">模型估算 (USDT)</th><td>{showModelAmount(data.model?.long)}</td><td>{showModelAmount(data.model?.short)}</td>
              <td>{showModelAmount(data.model?.total)}</td><td>—</td><td>—</td></tr>
            {data.references.map(({ source, status, amounts, delta, deltaPercent }) => (
              <tr key={source}><th scope="row">{source} ({source === "CryptoHFTData" ? "USDT" : "USD"}){status === "partial" ? " · 部分记录" : ""}</th>
                <td>{showAmount(amounts?.long)}</td><td>{showAmount(amounts?.short)}</td><td>{showAmount(amounts?.total)}</td>
                <td>{delta === null ? "—" : `${signedAmount.format(delta)}${status === "partial" ? "（对样本）" : ""}`}</td>
                <td>{deltaPercent === null ? amounts?.total === 0 && delta !== null ? "平台金额为 0" : "—"
                  : `${percent.format(deltaPercent)}%${status === "partial" ? "（对样本）" : ""}`}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>回测直接运行当前多／空强平模型，按 5 分钟顺序回放，在估算清算价首次被触及时计入金额。第三方金额只用于比较。</p>
      <p>参考来源只统计所选币安合约。各家可能收录同一笔强平，分别对比。差幅按「模型总额减平台总额，再除以平台总额」计算，按 1 USD 约等于 1 USDT。标有「对样本」的数字是 24 小时模型总额与平台已查到记录的差距，无法衡量完整 24 小时的误差。</p>
      <details>
        <summary>查看参考数据范围</summary>
        <ul>{data.references.map(({ source, detail }) => <li key={source}>{source} · {detail}</li>)}</ul>
      </details>
    </>}
  </div>;
}

export default function CoinLiquidations({ symbol }: { symbol: string }) {
  const [data, setData] = useState<LiquidationLevels | null>(null);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<ChartMode>("interval");

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ symbol });

    async function refresh() {
      try {
        const response = await fetch(apiUrl(`/api/markets/liquidations?${params}`), { signal: request.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Liquidation levels unavailable.");
        const snapshot: LiquidationLevels = await response.json();
        if (request.signal.aborted) return;
        setData(snapshot);
        setError(false);
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(refresh, LIQUIDATION_REFRESH_MS);
      }
    }
    void refresh();
    return () => { request.abort(); clearTimeout(timer); };
  }, [symbol]);

  return (
    <details className={`${styles.result} ${styles.turnover}`} open>
      <summary className={styles.researchSummary}><h4>多/空强平估算 <span>币安 · {symbol}</span></h4></summary>
      <p>只能估算达到某个价位时会有多少的多单和空单被强平。页面约每 {LIQUIDATION_REFRESH_MS / 1000} 秒刷新一次。</p>
      <Backtest key={symbol} symbol={symbol} />
      <details className={styles.liquidationMethod}>
        <summary>算法与数据来源</summary>
        <p>模型按未平仓量的变化估算仓位，再用杠杆、追加保证金和加仓情景推算强平价。</p>
        <p><strong>算法使用的 3 个币安接口</strong></p>
        <ul>
          <li>
            <code>openInterestHist</code> ：历史未平仓量。每 5 分钟记录一次还有多少合约没平掉。比如 BTCUSDT 永续合约在 00:00 的未平仓量是 10,000 BTC，00:05 是 10,200 BTC，说明这 5 分钟内未平仓合约净增了 200 BTC。这个差值看不出期间分别开了多少仓、平了多少仓。
            <p><strong>同一份合约有多仓和空仓两边，未平仓量只计一次。</strong> 未平仓量下降，说明还没平掉的合约变少了。价格是否下跌，要看卖单在什么价位成交。比如：</p>
            <ol>
              <li><strong>平仓多，价格也可以变化很小。</strong> 假设 BTC 在 50,000 USDT 附近，一批多头卖出平多，另一批空头买入平空。双方在这个价位附近成交了 1 万 BTC 的永续合约，多空两边都关闭了相应仓位。未平仓量减少 1 万 BTC，价格仍在 50,000 USDT 附近。</li>
              <li><strong>买单接不住时，价格可能快速下跌。</strong> 如果多头集中用市价单卖出平仓，而 50,000 USDT 附近的买单不够，卖单可能继续在 49,900、49,800 等更低价位成交。对其中每笔成交，买方若买入平空，未平仓量就会减少。买方若买入开多，多仓只是换了持有人，该笔成交的未平仓量不变。</li>
            </ol>
          </li>
          <li>
            <code>markPriceKlines</code> ：历史标记价 K 线。普通 K 线记录成交价，标记价 K 线记录币安用来判断是否触发强平的参考价。两种价格可能不同。假设一笔 BTC 空仓的强平价是 100,000 USDT，成交价插针到 100,000 USDT，但标记价最高只有 90,000 USDT。这根成交价插针本身不会触发该仓位强平。
            <ol>
              <li><strong>用当期收盘标记价近似入场价。</strong> 假设 00:00–00:05，BTC 未平仓量净增 200 BTC，这一段标记价 K 线收在 75,000 USDT。模型看不到每个交易员的真实开仓价，就用 75,000 USDT 作为这批估算仓位的入场价。按项目的简化公式，20 倍空头在未追加保证金时的估算强平价为 78,750 USDT。</li>
              <li><strong>用后续高低点判断估算价位有没有被触及。</strong> 假设下一根 BTC 标记价 K 线最高到 79,000 USDT，收在 77,000 USDT。虽然收盘已跌回 78,750 USDT 以下，但最高价已经越过该空头估算价位，模型会把它从清算图移除。多头则看后续最低价有没有跌到估算强平价。触及估算价位只说明标记价到过那里，真实强平金额需要另看成交记录。</li>
            </ol>
          </li>
          <li><code>premiumIndex</code> ：最新标记价快照。此接口也返回指数价和资金费率，下面绘制图表前会读取其中的标记价，用来划分上下方、计算距离和累计金额。</li>
        </ul>
        <p><strong>强平是如何计算出来的？</strong> </p>
        <ol>
          <li><strong>先按权重分配仓位。</strong> 未平仓量净增时，模型用同一段 K 线的收盘标记价近似入场价。每份新增合约都有多空两边。扣掉分给旧仓加仓的数量后，剩余部分按该方向的杠杆权重分配，默认档位为 1、2、3、5、10、20 倍。</li>
          <li><strong>把每档仓位拆成不同的追加保证金情景。</strong> 追加额按开仓时所需保证金的比例计算，并假设在触发强平前已经到账。每份估算仓位按情景占比分配一次。简化的强平距离为「入场价 ÷ 杠杆 ×（1 + 追加比例）」。多头从入场价减去这个距离，空头从入场价加上这个距离。
            <p>例如，BTC 在 75,000 USDT 开 20 倍空单，暂不计维持保证金时，未追加的估算强平价是 78,750 USDT。如果提前追加开仓保证金的 50%，估算强平价会上移到 80,625 USDT。多单追加保证金后，估算强平价会下移。这个简化模型下，1 倍多单没有正数强平价。</p>
            {data?.positionAddScenario && <div className={styles.tableScroll}>
              <table aria-label="多空追加保证金情景">
                <thead><tr><th scope="col">追加额占初始保证金</th><th scope="col">多单仓位占比</th><th scope="col">空单仓位占比</th></tr></thead>
                <tbody>{data.marginScenarios.map(({ extraInitialMarginFraction, long, short }) => (
                  <tr key={extraInitialMarginFraction}>
                    <th scope="row">{extraInitialMarginFraction === 0 ? "不追加" : weightPercent.format(extraInitialMarginFraction)}</th>
                    <td>{weightPercent.format(long)}</td><td>{weightPercent.format(short)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>}
          </li>
          <li><strong>考虑逆势加仓后，强平价可能变远。</strong> 仅在未平仓量净增、原仓在该根 K 线内尚未触及估算强平价时，按收盘标记价尝试加仓。多单下跌时加多，空单上涨时加空。加仓沿用原杠杆，并为新增数量计入初始保证金。模型合并原仓和加仓的成本与保证金，仅在重算后的强平价离当时标记价更远时采用这个情景。
            {data?.positionAddScenario && <p>收盘价须从原入场价向强平价走完至少 {weightPercent.format(data.positionAddScenario.adverseDistanceFraction)} 的距离。每个方向最多用该段未平仓净增量的 {weightPercent.format(data.positionAddScenario.maxNetIncreaseFraction)}，每批旧仓最多加原有数量的 {weightPercent.format(data.positionAddScenario.maxPositionIncreaseFraction)}，且只加一次。用掉的净增量会从同侧的新开仓估算中扣除。</p>}
            <p>例如，BTC 以 100,000 USDT 开 1 BTC 的 10 倍多单，简化强平价为 90,000 USDT。在 95,000 USDT 再买入 0.25 BTC 并补足这部分初始保证金，简化强平价降到 89,100 USDT。价格需要再跌更多才会触发，但到时被强平的仓位可能更大。</p>
          </li>
          <li>持仓量下降时，按持仓剩余比例缩减估算仓位。后来被标记价触及的估算清算位从快照中移除。</li>
          <li><strong>按距离当前标记价的涨跌幅分区间。</strong> 模型先用「估算仓位数量 × 估算清算价」计算每笔仓位的 USDT 金额。图上用较细的区间展示，表格再把金额合并到较宽、宽度不同的区间，多头展示到 −95%，空头展示到 +1,000%。例如 BTC 的当前标记价为 50,000 USDT，多头表中的 −10% 至 −5% 就对应 45,000 至 47,500 USDT，该行的区间金额是归入这一档的估算金额之和。</li>
        </ol>
        <p><strong>第一步看历史流通市值。</strong> 优先用最近完整的 360 天日数据取中位数。数据不足时依次尝试 180、60、30 天。币安合约上市未满 30 天时，最后可用上市后的有效日样本。CoinGecko 历史不足时，尝试用币安日持仓快照的隐含价格和 CoinMarketCap 流通量估算。</p>
        <p>按美元市值从低到高分七档。低于 2,000 万为极度高风险，接下来以低于 6,000 万、2 亿、10 亿、50 亿、300 亿为上界，依次对应很高、高、中、低、较低风险。达到 300 亿为稳定档。这些标签用于分配模型权重。</p>
        <p><strong>第二步看合约成交活跃度。</strong> 用币安该永续合约过去 24 小时的成交额除以最新流通市值，计算时按 1 USDT 约等于 1 美元处理。比值按 17.5%、25%、50%、100%、200% 分六档，恰好达到分界值时归入较低一档。比值越高，模型越压低高杠杆权重。缺少成交额或市值时，成交活跃度不参与调整。</p>
        <p><strong>第三步合并两个系数。</strong> 先按多空各自的基准和大额、小额仓位 75% / 25% 的假设计算基础权重。再把市值系数和成交活跃度系数相乘。5 倍权重乘合并系数的平方根，10 倍乘合并系数，20 倍乘合并系数的平方。剩余权重分给 1、2、3 倍。</p>
        <p>在 1–3 倍的权重中，1 倍档先分到多单的 20%、空单的 30%，再加上「25% ×（1 − 合并系数）」。合并系数越低，1 倍分到的比例越大。余下的权重按原比例分给 2 倍和 3 倍，多空各自加总为 100%。</p>
        {data?.leverageWeighting.marginProfile ? <p>采用币安当前小额仓位档位。最高 {data.leverageWeighting.marginProfile.maxLeverage} 倍，维持保证金率 {weightPercent.format(data.leverageWeighting.marginProfile.maintenanceRate)}。上限低于 20 倍时，把超出的权重合并到上限。上限高于 20 倍时，把原 20 倍档的一半分给更高档位及合约上限。</p>
          : data && <p>暂未取得币安档位，表格展示备用杠杆情景。</p>}
        <p>计入维持保证金时，多头用简化强平价除以「1 − 维持保证金率」，空头除以「1 + 维持保证金率」，两边的强平价都会更靠近入场价。杠杆权重、追加保证金和加仓分配都是模型假设。公开行情看不到逐账户的仓位、实际保证金和全仓余额。模型使用上述小额仓位的费率，尚未覆盖完整的保证金档位及费用。多头估算强平价小于或等于 0 时，不显示在可触发的价带内。</p>
        {data && <>
          <p>本次市值档 {data.leverageWeighting.marketCapBand.label} · 市值系数 {weightPercent.format(data.leverageWeighting.marketCapBand.factor)}。
            {data.leverageWeighting.capitalization
              ? ` 流通市值中位数约 ${amount.format(data.leverageWeighting.capitalization.medianUsd)} 美元（${data.leverageWeighting.capitalization.windowDays} 天，${data.leverageWeighting.capitalization.samples} 个日样本，${data.leverageWeighting.capitalization.source === "coingecko" ? "CoinGecko" : "币安持仓与 CMC 流通量估算"}）。`
              : " 市值历史不足时，BTC 和 ETH 使用稳定档，其他合约使用极度高风险档作为备用。"}
          </p>
          {data.leverageWeighting.turnover && <p>
            24 小时合约成交额 {amount.format(data.leverageWeighting.turnover.volumeUsdt)} USDT · 最新流通市值 {amount.format(data.leverageWeighting.turnover.marketCapUsd)} 美元
            （{data.leverageWeighting.turnover.marketCapSource === "binance-cmc-proxy" ? "币安标记价与 CMC 流通量估算" : data.leverageWeighting.turnover.marketCapSource}）。
          </p>}
          <p>
            {data.leverageWeighting.turnover
              ? `成交额 / 流通市值 ${weightPercent.format(data.leverageWeighting.turnover.ratio)} · ${data.leverageWeighting.turnover.band.label} 档 · 活跃度系数 ${weightPercent.format(data.leverageWeighting.turnover.band.factor)}`
              : "成交活跃度数据不足 · 活跃度系数 100%"}
            {" · "}合并系数 {weightPercent.format(data.leverageWeighting.factor)}
          </p>
          <p><strong>当前杠杆权重</strong>。例如，某档多单权重显示 5%，每有 100 BTC 分配到新开的多单仓位，就有 5 BTC 计入这一档。空单权重同样读。</p>
          <div className={styles.tableScroll}>
            <table aria-label="当前多空杠杆权重">
              <thead><tr><th scope="col">杠杆倍数</th><th scope="col">多单权重</th><th scope="col">空单权重</th></tr></thead>
              <tbody>{data.leverageWeighting.weights.map(({ leverage, long, short }) => (
                <tr key={leverage}><th scope="row">{leverage} 倍</th><td>{weightPercent.format(long)}</td><td>{weightPercent.format(short)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>}
      </details>
      {error && <p role="status">{data ? "更新失败，以下为上次快照。" : "清算区暂不可用，正在重试。"}</p>}
      {!data && !error && <p role="status">正在估算清算区…</p>}
      {data && <>
        <p>当前参考价 {price.format(data.markPrice)} USDT · 行情时间 {time.format(data.asOf)} · 持仓数据截至 {time.format(data.interestThrough)}</p>
        <label className={`${styles.pairSelect} ${styles.liquidationOrder}`}>
          <span>图表口径</span>
          <select value={mode} onChange={(event) => setMode(event.target.value === "cumulative" ? "cumulative" : "interval")}>
            <option value="interval">单区间金额</option>
            <option value="cumulative">累计金额</option>
          </select>
        </label>
        <LiquidationChart data={data} mode={mode} />
        <div className={styles.liquidationGrid}>
          <Levels title="下方 · 潜在多头清算" data={data} side="long" />
          <Levels title="上方 · 潜在空头清算" data={data} side="short" />
        </div>
      </>}
    </details>
  );
}
