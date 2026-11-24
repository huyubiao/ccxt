import { isLocalSettingsRequest, isSameOrigin, readLocalJson } from "./local-settings-request";
import { proxyMarketRequest } from "./market-service-proxy";

/** POSTs that place or close orders: local settings mode, same origin, JSON only. */
export async function forwardTradingPost(request: Request, route: "/api/trading/test-order" | "/api/trading/close") {
  if (!isLocalSettingsRequest(request) || !isSameOrigin(request)) {
    return Response.json({ error: "当前请求不能下单。" }, { status: 403 });
  }
  const body = await readLocalJson(request);
  if (body.status !== 200) {
    const error = body.status === 413 ? "请求体过大。" : body.status === 415 ? "需要 JSON 格式的请求。" : "请求无效。";
    return Response.json({ error }, { status: body.status });
  }
  return proxyMarketRequest(route, request, body.text);
}
