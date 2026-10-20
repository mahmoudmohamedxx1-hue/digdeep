import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const maxDuration = 60;

/**
 * GET /api/workspaces/[id] — one workspace: members + the shared research
 * library (completed jobs, newest first) with verdict + pre-ship score. This
 * is the data behind the workspace audit view (P2-2).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const { id } = await params;
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: id, userId: user.id } },
  });
  if (!membership) return NextResponse.json({ error: "Not a member of this workspace." }, { status: 403 });
  const ws = await db.workspace.findUnique({
    where: { id },
    include: { members: { include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: "asc" } }, owner: { select: { name: true, email: true } } },
  });
  if (!ws) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });

  // shared research library: this workspace's runs only (personal runs excluded)
  const jobs = await db.researchJob.findMany({
    where: { workspaceId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, threadId: true, query: true, status: true, mode: true, court: true, domain: true,
      preset: true, createdAt: true, completedAt: true, reportMd: true, stats: true,
    },
  });
  const library = jobs.map((j) => {
    let stats: Record<string, unknown> = {};
    try { stats = j.stats ? JSON.parse(j.stats) : {}; } catch { stats = {}; }
    const court = stats.court as { verdict?: string } | undefined;
    const reportScore = stats.reportScore as { overall?: number; dims?: Record<string, number> } | undefined;
    return {
      id: j.id,
      threadId: j.threadId,
      query: j.query,
      status: j.status,
      mode: j.mode,
      court: j.court,
      verdict: court?.verdict ?? null,
      reportScore: reportScore?.overall ?? null,
      domain: j.domain,
      preset: j.preset,
      hasReport: !!j.reportMd,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
    };
  });

  return NextResponse.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      role: membership.role,
      inviteCode: membership.role === "owner" ? ws.inviteCode : null,
      owner: ws.owner.name ?? ws.owner.email,
      createdAt: ws.createdAt.toISOString(),
    },
    members: ws.members.map((m) => ({
      id: m.id,
      name: m.user.name ?? m.user.email,
      email: m.user.email,
      role: m.role,
      joined: m.createdAt.toISOString(),
    })),
    library,
  });
}
