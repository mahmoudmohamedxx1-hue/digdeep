import { NextResponse } from "next/server";
import { getPublicStats } from "@/lib/platform/public-stats";

export const dynamic = "force-dynamic";

/**
 * v3.4 — GET /api/stats : the public track record, live from production.
 * Powers the /benchmark page's "Track record" section; open for anyone to
 * cite (the whole point — auditable numbers, not marketing claims).
 */
export async function GET() {
  return NextResponse.json(await getPublicStats());
}
