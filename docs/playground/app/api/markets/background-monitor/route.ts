import { isLocalSettingsRequest, isSameOrigin, readLocalJson } from "@/lib/local-settings-request";
import { proxyMarketRequest } from "@/lib/market-service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/markets/background-monitor";

export function GET(request: Request) {
  if (!isLocalSettingsRequest(request)) {
    return Response.json({ error: "后台监控仅在本地设置模式下可管理。" }, { status: 403 });
  }
  return proxyMarketRequest(route, request);
}

async function write(request: Request, forbidden: string, invalid: string, mediaType: string) {
  if (!isLocalSettingsRequest(request) || !isSameOrigin(request)) {
    return Response.json({ error: forbidden }, { status: 403 });
  }
  const body = await readLocalJson(request);
  if (body.status !== 200) {
    const error = body.status === 413 ? "请求体过大。" : body.status === 415 ? mediaType : invalid;
    return Response.json({ error }, { status: body.status });
  }
  return proxyMarketRequest(route, request, body.text);
}

export function PUT(request: Request) {
  return write(request, "当前请求无法修改后台监控设置。", "请检查告警时间窗口、涨跌幅、成交额倍数、观察期和延续评分参数。", "需要 JSON 规则。");
}

export function DELETE(request: Request) {
  return write(request, "当前请求无法删除监控记录。", "请选择有效的告警记录。", "需要 JSON 格式的监控记录。");
}
