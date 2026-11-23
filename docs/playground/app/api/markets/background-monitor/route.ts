import { SPIKE_RECORD_LIMIT } from "@/lib/alert-history";
import type { AutoOrderWatchIdentity } from "@/lib/auto-order";
import { backgroundStore } from "@/lib/background-monitor-store";
import { ensureBackgroundMonitor } from "@/lib/background-monitor-process";
import { readBackgroundRule } from "@/lib/background-monitor-types";
import type { SpikeIdentity } from "@/lib/price-alerts";
import { localSettingsEnabled } from "@/lib/strategy-notifications";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function localRequest(request: Request) {
  return localSettingsEnabled() && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.get("host") ?? "");
}

function localWriteRequest(request: Request) {
  const origin = URL.parse(request.headers.get("origin") ?? "");
  const site = request.headers.get("sec-fetch-site");
  return localRequest(request) && origin && ["http:", "https:"].includes(origin.protocol) &&
    origin.host === request.headers.get("host") && (site === null || site === "same-origin");
}

function hasJsonBody(request: Request) {
  return request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

function isSpikeIdentity(value: unknown): value is SpikeIdentity {
  if (!value || typeof value !== "object") return false;
  const { symbol, time, threshold } = value as Partial<SpikeIdentity>;
  return typeof symbol === "string" && symbol.length > 0 && symbol.length <= 64 &&
    typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time <= 8.64e15 &&
    typeof threshold === "number" && Number.isFinite(threshold);
}

function isAutoOrderWatchIdentity(value: unknown): value is AutoOrderWatchIdentity {
  if (!value || typeof value !== "object") return false;
  const { symbol, strategy, time } = value as Partial<AutoOrderWatchIdentity>;
  return typeof symbol === "string" && symbol.length > 0 && symbol.length <= 80 &&
    typeof strategy?.id === "string" && strategy.id.length > 0 && strategy.id.length <= 80 &&
    typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time <= 8.64e15;
}

export function GET(request: Request) {
  if (!localRequest(request)) return Response.json({ error: "后台监控仅在本地设置模式下可管理。" }, { status: 403 });
  try {
    const data = backgroundStore().status(Date.now());
    if (data.rule.enabled && data.worker === "offline") void ensureBackgroundMonitor();
    return Response.json(data, { headers: noStore });
  } catch {
    return Response.json({ error: "无法读取后台监控记录。" }, { status: 503, headers: noStore });
  }
}

export async function PUT(request: Request) {
  if (!localWriteRequest(request)) {
    return Response.json({ error: "当前请求无法修改后台监控设置。" }, { status: 403 });
  }
  if (!hasJsonBody(request)) {
    return Response.json({ error: "需要 JSON 规则。" }, { status: 415 });
  }
  const rule = readBackgroundRule(await request.json().catch(() => null));
  if (!rule) return Response.json({ error: "请检查时间窗口、涨跌幅和成交额倍数。" }, { status: 400 });
  try {
    const store = backgroundStore();
    store.saveRule(rule);
    if (rule.enabled) await ensureBackgroundMonitor();
    return Response.json(store.status(Date.now()), { headers: noStore });
  } catch {
    return Response.json({ error: "无法保存后台监控设置。" }, { status: 503, headers: noStore });
  }
}

export async function DELETE(request: Request) {
  if (!localWriteRequest(request)) {
    return Response.json({ error: "当前请求无法删除监控记录。" }, { status: 403 });
  }
  if (!hasJsonBody(request)) {
    return Response.json({ error: "需要 JSON 格式的监控记录。" }, { status: 415 });
  }
  const records: unknown = await request.json().catch(() => null);
  if (records && typeof records === "object" && "autoOrderWatches" in records) {
    const watches = records.autoOrderWatches;
    if (!Array.isArray(watches) || !watches.length || !watches.every(isAutoOrderWatchIdentity)) {
      return Response.json({ error: "请选择有效的自动下单任务记录。" }, { status: 400 });
    }
    try {
      const store = backgroundStore();
      store.deleteAutoOrderWatches(watches);
      return Response.json(store.status(Date.now()), { headers: noStore });
    } catch {
      return Response.json({ error: "无法删除自动下单任务记录。" }, { status: 503 });
    }
  }
  if (!Array.isArray(records) || !records.length || records.length > SPIKE_RECORD_LIMIT || !records.every(isSpikeIdentity)) {
    return Response.json({ error: "请选择有效的告警记录。" }, { status: 400 });
  }
  try {
    const store = backgroundStore();
    store.deleteSpikes(records);
    return Response.json(store.status(Date.now()), { headers: noStore });
  } catch {
    return Response.json({ error: "无法删除告警记录。" }, { status: 503, headers: noStore });
  }
}
