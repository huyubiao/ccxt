import { forwardTradingPost } from "@/lib/trading-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return forwardTradingPost(request, "/api/trading/close");
}
