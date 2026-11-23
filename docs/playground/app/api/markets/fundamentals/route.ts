import { proxyMarketRequest } from "@/lib/market-service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return proxyMarketRequest("/api/markets/fundamentals", request);
}
