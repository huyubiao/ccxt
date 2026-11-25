import { isLocalSettingsRequest } from "@/lib/local-settings-request";
import { proxyMarketRequest } from "@/lib/market-service-proxy";
import { forwardTradingMutation } from "@/lib/trading-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (!isLocalSettingsRequest(request)) {
    return Response.json({ error: "下单仅在本地设置模式下可用。" }, { status: 403 });
  }
  return proxyMarketRequest("/api/trading", request);
}

export async function DELETE(request: Request) {
  const response = await forwardTradingMutation(request, "/api/trading");
  if (response.status === 405) {
    return Response.json(
      { error: "当前运行的后端版本不支持删除下单记录，请重启 Playground 后再试。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return response;
}
