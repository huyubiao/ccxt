import type { BackgroundRecord, ContinuationResult } from "./background-monitor-types";
import { spikeKey, type SpikeRecord } from "./price-alerts";

export const SPIKE_RECORD_LIMIT = 100;
const STORAGE_KEY = "ccxt-market-spike-records";

export const spikeStatusLabels: Record<SpikeRecord["status"], string> = {
  pending: "排队核验",
  alerted: "已触发告警",
  upgraded: "成交额已达标，告警已升级",
  "below-threshold": "成交额未达标",
  unavailable: "成交额数据不足或查询失败",
  skipped: "队列已满，未核验",
  interrupted: "核验已中断",
};

export type AlertHistoryRow = SpikeRecord & { legacyMultiple?: number | null; continuation?: ContinuationResult };

export function mergeAlertHistory(
  browser: readonly SpikeRecord[], server: readonly SpikeRecord[] = [], confirmed: readonly BackgroundRecord[] = [],
): AlertHistoryRow[] {
  const rows = new Map<string, AlertHistoryRow>(browser.map((row) => [spikeKey(row), row]));
  for (const { event } of confirmed) {
    rows.set(spikeKey(event), { ...event, requiredMultiple: null, status: "alerted", legacyMultiple: event.multiple });
  }
  for (const row of server) {
    const key = spikeKey(row);
    const confirmedRow = rows.get(key);
    rows.set(key, row.status === "alerted" && confirmedRow?.status === "alerted"
      ? { ...row, volume: row.volume ?? confirmedRow.volume, legacyMultiple: confirmedRow.legacyMultiple,
        continuation: confirmedRow.continuation }
      : row);
  }
  return [...rows.values()].sort((a, b) => b.time - a.time).slice(0, SPIKE_RECORD_LIMIT);
}

export function readSpikeRecords(): SpikeRecord[] {
  try {
    const rows = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is SpikeRecord => row && typeof row.symbol === "string" &&
      Number.isSafeInteger(row.time) && row.time > 0 && row.time <= 8.64e15 &&
      [row.price, row.previous, row.change, row.threshold, row.seconds].every(Number.isFinite) &&
      (row.requiredMultiple === null || Number.isFinite(row.requiredMultiple)) &&
      Object.hasOwn(spikeStatusLabels, row.status))
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

export function retainSpikeRecords(rows: readonly SpikeRecord[]) {
  return rows.toSorted((a, b) => b.time - a.time).slice(0, SPIKE_RECORD_LIMIT);
}

export function saveSpikeRecords(rows: SpikeRecord[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); } catch { /* Keep the current session records. */ }
}
