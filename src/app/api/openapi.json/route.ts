import { NextResponse } from "next/server";
import { openApiSpec } from "@/lib/platform/openapi";

export const dynamic = "force-dynamic";

/**
 * v3.4 — GET /api/openapi.json : the machine-readable API contract.
 * Single source of truth lives in src/lib/platform/openapi.ts; the /api-docs
 * page renders from the same object.
 */
export async function GET() {
  return NextResponse.json(openApiSpec, {
    headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
