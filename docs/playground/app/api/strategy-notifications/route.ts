import { isLocalSettingsRequest, isSameOrigin, readLocalJson } from "@/lib/local-settings-request";
import { proxyMarketRequest } from "@/lib/market-service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = "/api/strategy-notifications";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!isLocalSettingsRequest(request)) {
    return Response.json({ status: "unconfigured", canConfigure: false }, { headers });
  }
  const response = await proxyMarketRequest(route, request);
  if (!response.ok) return response;
  const { status } = await response.json();
  return Response.json({ status, canConfigure: true }, { headers });
}

async function write(request: Request, invalidStatus: "invalid" | "invalid-event") {
  if (!isLocalSettingsRequest(request) || !isSameOrigin(request)) {
    return Response.json({ status: "forbidden" }, { status: 403, headers });
  }
  const body = await readLocalJson(request);
  if (body.status !== 200) {
    const status = body.status === 400 ? invalidStatus : "invalid-event";
    return Response.json({ status }, { status: body.status, headers });
  }
  return proxyMarketRequest(route, request, body.text);
}

export function PUT(request: Request) {
  return write(request, "invalid");
}

export function POST(request: Request) {
  return write(request, "invalid-event");
}
