import { NextResponse } from "next/server";
import { getContractDirectory } from "@/lib/binance-usdm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getContractDirectory(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法同步币安合约列表。" }, { status: 502 });
  }
}
