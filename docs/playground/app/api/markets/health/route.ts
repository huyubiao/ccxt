import { proxyMarketRequest } from "@/lib/market-service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const response = await proxyMarketRequest("/health", request);
  if (response.status === 204) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  void response.body?.cancel().catch(() => {});
  return Response.json({ error: "Rust 行情服务暂时不可用。" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}
