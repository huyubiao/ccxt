import { forwardTradingMutation } from "@/lib/trading-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request) {
  return forwardTradingMutation(request, "/api/trading/account");
}
