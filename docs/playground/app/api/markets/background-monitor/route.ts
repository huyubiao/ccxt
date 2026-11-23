import { backgroundStore } from "@/lib/background-monitor-store";
import { ensureBackgroundMonitor } from "@/lib/background-monitor-process";
import { readBackgroundRule } from "@/lib/background-monitor-types";
import { localSettingsEnabled } from "@/lib/strategy-notifications";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function localRequest(request: Request) {
  return localSettingsEnabled() && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.get("host") ?? "");
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
  const origin = URL.parse(request.headers.get("origin") ?? "");
  const site = request.headers.get("sec-fetch-site");
  if (!localRequest(request) || !origin || !["http:", "https:"].includes(origin.protocol) ||
      origin.host !== request.headers.get("host") || (site !== null && site !== "same-origin")) {
    return Response.json({ error: "当前请求无法修改后台监控设置。" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
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
