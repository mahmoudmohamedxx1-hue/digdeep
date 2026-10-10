import { NextResponse } from 'next/server'
import { llm } from '@/lib/llm/router'

export const dynamic = 'force-dynamic'

export async function GET() {
  const status = await llm.status()
  return NextResponse.json(status)
}
