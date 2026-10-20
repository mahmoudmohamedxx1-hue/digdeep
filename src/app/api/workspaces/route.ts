import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { randomBytes } from "crypto";

export const maxDuration = 60;

/** GET /api/workspaces — my workspaces (owned + member) with job counts. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const rows = await db.workspaceMember.findMany({
    where: { userId: user.id },
    include: {
      workspace: {
        include: {
          _count: { select: { jobs: true, members: true } },
          owner: { select: { name: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const workspaces = rows.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    inviteCode: m.role === "owner" ? m.workspace.inviteCode : null,
    owner: m.workspace.owner.name ?? m.workspace.owner.email,
    jobs: m.workspace._count.jobs,
    members: m.workspace._count.members,
    createdAt: m.workspace.createdAt.toISOString(),
  }));
  return NextResponse.json({ workspaces });
}

/**
 * POST /api/workspaces — action-based:
 *  { action: "create", name }                    → new workspace (creator = owner)
 *  { action: "join", code }                      → join by invite code
 *  { action: "rename", id, name }                → owner renames
 *  { action: "regenerate-code", id }             → owner rotates the invite code
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");

  if (action === "create") {
    const name = String(body.name || "").trim().slice(0, 80);
    if (name.length < 2) return NextResponse.json({ error: "Workspace name must be 2-80 characters." }, { status: 400 });
    const inviteCode = randomBytes(6).toString("base64url");
    const ws = await db.workspace.create({
      data: {
        name,
        ownerId: user.id,
        inviteCode,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    return NextResponse.json({ workspace: { id: ws.id, name: ws.name, inviteCode, role: "owner" } });
  }

  if (action === "join") {
    const code = String(body.code || "").trim();
    if (!code) return NextResponse.json({ error: "Enter an invite code." }, { status: 400 });
    const ws = await db.workspace.findUnique({ where: { inviteCode: code } });
    if (!ws) return NextResponse.json({ error: "No workspace matches that invite code." }, { status: 404 });
    const existing = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } },
    });
    if (existing) return NextResponse.json({ error: "You are already a member of this workspace." }, { status: 409 });
    await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: "member" } });
    return NextResponse.json({ workspace: { id: ws.id, name: ws.name, role: "member" } });
  }

  if (action === "rename" || action === "regenerate-code") {
    const id = String(body.id || "");
    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws || ws.ownerId !== user.id) return NextResponse.json({ error: "Only the workspace owner can do that." }, { status: 403 });
    if (action === "rename") {
      const name = String(body.name || "").trim().slice(0, 80);
      if (name.length < 2) return NextResponse.json({ error: "Workspace name must be 2-80 characters." }, { status: 400 });
      const updated = await db.workspace.update({ where: { id }, data: { name } });
      return NextResponse.json({ workspace: { id: updated.id, name: updated.name } });
    }
    const inviteCode = randomBytes(6).toString("base64url");
    await db.workspace.update({ where: { id }, data: { inviteCode } });
    return NextResponse.json({ inviteCode });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
