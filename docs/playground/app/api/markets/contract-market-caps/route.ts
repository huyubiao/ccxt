import { NextResponse } from "next/server";
import { getContractMarketCaps } from "@/lib/coin-fundamentals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getContractMarketCaps(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法同步合约流通市值。" }, { status: 502 });
  }
}
