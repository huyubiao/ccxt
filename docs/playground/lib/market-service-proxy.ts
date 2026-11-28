import { Agent } from "undici";

type RustMarketRoute = "/health" | "/api/markets/contracts" | "/api/markets/alert-context" |
  "/api/markets/background-monitor" | "/api/strategy-notifications" | "/api/markets/directory" |
  "/api/markets/ticker" | "/api/markets/order-book" | "/api/markets/funding-rates" | "/api/markets/liquidations" |
  "/api/markets/volume" | "/api/markets/contract-market-caps" | "/api/markets/fundamentals" | "/api/markets/holders" |
  TradingRoute;
export type TradingRoute = "/api/trading" | "/api/trading/account" | "/api/trading/test-order" | "/api/trading/close" |
  "/api/trading/position";
const localRoutes = new Set<RustMarketRoute>([
  "/api/markets/background-monitor", "/api/strategy-notifications",
  "/api/trading", "/api/trading/account", "/api/trading/test-order", "/api/trading/close", "/api/trading/position",
]);

const loopbackAgent = new Agent();

export async function proxyMarketRequest(route: RustMarketRoute, request: Request, body?: string): Promise<Response> {
  const base = process.env.PLAYGROUND_MARKET_SERVICE_URL?.trim();
  if (!base) return unavailable(route);
  try {
    const endpoint = new URL(route, base);
    endpoint.search = new URL(request.url).search;
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    const requiresToken = localRoutes.has(route);
    if (requiresToken) {
      const token = process.env.PLAYGROUND_MARKET_SERVICE_TOKEN ?? "";
      if (!/^[a-f0-9]{64}$/i.test(token) || endpoint.protocol !== "http:" ||
          !["127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
        throw new Error("Invalid local market service configuration");
      }
      headers.set("authorization", `Bearer ${token}`);
    }
    const timeout = AbortSignal.timeout(route === "/health" ? 4_000 : 60_000);
    const options = {
      method: request.method, headers, body, cache: "no-store", redirect: "error",
      dispatcher: requiresToken ? loopbackAgent : undefined,
      signal: AbortSignal.any([request.signal, timeout]),
    } as const;
    const response = await fetch(endpoint, options);
    const responseHeaders = new Headers();
    for (const header of ["content-type", "cache-control"]) {
      const value = response.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return unavailable(route);
  }
}

function unavailable(route: RustMarketRoute): Response {
  const data = route === "/api/strategy-notifications" ? { status: "config-unavailable" }
    : { error: "Rust 行情服务暂时不可用。" };
  return Response.json(data, { status: 503, headers: { "Cache-Control": "no-store" } });
}
