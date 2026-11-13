import type { AlertTurnover } from "@/lib/price-alerts";
import styles from "./markets.module.css";

export const SPIKE_RECORD_LIMIT = 100;
const STORAGE_KEY = "ccxt-market-spike-records";

const statusLabels = {
  pending: "排队核验",
  alerted: "已触发告警",
  upgraded: "成交额已达标，告警已升级",
  "below-threshold": "成交额未达标",
  unavailable: "成交额数据不足或查询失败",
  skipped: "队列已满，未核验",
  interrupted: "核验已中断",
};

export type SpikeRecord = {
  symbol: string;
  time: number;
  price: number;
  previous: number;
  change: number;
  threshold: number;
  seconds: number;
  level: number;
  requiredMultiple: number | null;
  status: keyof typeof statusLabels;
  volume?: AlertTurnover & { multiple: number | null };
};

const formatTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
const formatPercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatPrice = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 12 });
const formatAmount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function readSpikeRecords(): SpikeRecord[] {
  try {
    const rows = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is SpikeRecord => row && typeof row.symbol === "string" &&
      Number.isSafeInteger(row.time) && row.time > 0 && row.time <= 8.64e15 &&
      [row.price, row.previous, row.change, row.threshold, row.seconds].every(Number.isFinite) &&
      (row.requiredMultiple === null || Number.isFinite(row.requiredMultiple)) &&
      Object.hasOwn(statusLabels, row.status))
      .slice(0, SPIKE_RECORD_LIMIT)
      .map((row) => ({
        ...row,
        level: Number.isSafeInteger(row.level) && row.level > 0 ? row.level : 1,
        status: row.status === "pending" ? "interrupted" : row.status,
      }));
  } catch {
    return [];
  }
}

export function saveSpikeRecords(rows: SpikeRecord[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); } catch { /* Keep the current session records. */ }
}

function amount(value?: number | null) {
  return value == null ? "—" : formatAmount.format(value);
}

export default function SpikeRecords({ records }: { records: SpikeRecord[] }) {
  return (
    <section id="spike-records" className={styles.monitorPanel} aria-labelledby="spike-records-heading">
      <h2 id="spike-records-heading" className={styles.sectionTitle}>超阈值记录</h2>
      <div className={styles.spikeRecords}>
        <p>记录达到涨跌阈值的交易对，并显示成交额核验结果。保留最近 {SPIKE_RECORD_LIMIT} 条。</p>
        {records.length === 0 ? <p role="status">暂无达到涨跌阈值的记录。</p> : (
          <div className={styles.tableScroll}>
            <table>
              <thead><tr>
                <th scope="col">交易对</th><th scope="col">级别</th><th scope="col">触发时间</th>
                <th scope="col">参考价 (USDT)</th><th scope="col">触发价 (USDT)</th>
                <th scope="col">涨跌幅 / 阈值</th><th scope="col">窗口 (秒)</th>
                <th scope="col">成交额 (USDT)</th><th scope="col">基准 (USDT)</th>
                <th scope="col">成交额倍数 / 门槛</th><th scope="col">核验结果</th>
              </tr></thead>
              <tbody>
                {records.map((row) => (
                  <tr key={`${row.symbol}:${row.time}:${row.threshold}`}>
                    <th scope="row">{row.symbol}</th>
                    <td>{row.level} 级</td>
                    <td><time dateTime={new Date(row.time).toISOString()}>{formatTime.format(row.time)}</time></td>
                    <td>{formatPrice.format(row.previous)}</td>
                    <td>{formatPrice.format(row.price)}</td>
                    <td className={row.change < 0 ? styles.sell : styles.buy}>
                      {formatPercent.format(row.change)}% / {formatPercent.format(row.threshold)}%
                    </td>
                    <td>{row.seconds}</td>
                    <td>{amount(row.volume?.turnover)}</td>
                    <td>{amount(row.volume?.baseline)}</td>
                    <td>{row.requiredMultiple === null ? "沿用首轮核验"
                      : <>{row.volume?.multiple == null ? "—" : `${amount(row.volume.multiple)} 倍`} / {amount(row.requiredMultiple)} 倍</>}</td>
                    <td>{statusLabels[row.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
