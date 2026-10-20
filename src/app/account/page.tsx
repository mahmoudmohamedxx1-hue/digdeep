"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Copy, KeyRound, LogOut, Plus, RefreshCw, Scale, ShieldCheck, Users, Check, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { getThreadTurns } from "@/lib/idb-store";
import { useSettings } from "@/lib/store";

/**
 * P1-1 / P2-2 / P2-3 — Account: sign in / register (with anonymous-history
 * migration), API keys for the verified-report API, and team workspaces.
 */

type SessionUser = { id: string; email: string; name: string | null };
type ApiKeyRow = { id: string; name: string; prefix: string; revoked: boolean; lastUsedAt: string | null; createdAt: string };
type WorkspaceRow = { id: string; name: string; role: string; inviteCode: string | null; owner: string; jobs: number; members: number; createdAt: string };

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  // auth form
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // api keys
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  // workspaces
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [wsName, setWsName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [claimed, setClaimed] = useState<number | null>(null);
  const court = useSettings((s) => s.court);

  const loadAll = useCallback(async () => {
    try {
      const res = await fetch("/api/auth").then((r) => r.json());
      const u = (res.user ?? null) as SessionUser | null;
      setUser(u);
      if (u) {
        const [k, w] = await Promise.all([
          fetch("/api/keys").then((r) => r.json()),
          fetch("/api/workspaces").then((r) => r.json()),
        ]);
        setKeys(k.keys ?? []);
        setWorkspaces(w.workspaces ?? []);
      }
    } catch {
      /* offline — the page still renders the sign-in form */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  /** Collect the browser's anonymous thread ids so sign-in can adopt them. */
  async function localThreadIds(): Promise<string[]> {
    try {
      const turns = await getThreadTurns("__all__").catch(() => null);
      if (turns) return [...new Set(turns.map((t) => t.job?.threadId).filter(Boolean) as string[])];
    } catch { /* no idb */ }
    try {
      const db = await indexedDB.databases?.();
      if (!db) return [];
    } catch { /* Safari legacy */ }
    // fall back to scanning the turns store through the library listing
    const { listHistory } = await import("@/lib/idb-store");
    const hist = await listHistory(200).catch(() => []);
    return hist.map((h) => h.threadId).filter((x): x is string => !!x);
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const claimThreadIds = await localThreadIds();
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, email, password, name: name || undefined, claimThreadIds }),
      }).then((r) => r.json());
      if (res.error) {
        toast({ title: res.error });
        return;
      }
      setUser(res.user);
      setClaimed(res.claimed ?? 0);
      if (res.claimed > 0) {
        toast({ title: `Welcome back — ${res.claimed} of your anonymous research thread${res.claimed > 1 ? "s" : ""} now sync to this account.` });
      }
      await loadAll();
    } catch {
      toast({ title: "Sign-in failed — check your connection." });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    setUser(null);
    setKeys([]);
    setWorkspaces([]);
    toast({ title: "Signed out. Your local history stays in this browser." });
  }

  async function createKey() {
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: keyName || "default" }),
    }).then((r) => r.json());
    if (res.error) {
      toast({ title: res.error });
      return;
    }
    setFreshKey(res.key);
    setKeyName("");
    await loadAll();
  }

  async function revokeKey(id: string) {
    await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke", id }),
    });
    await loadAll();
  }

  async function createWorkspace() {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: wsName }),
    }).then((r) => r.json());
    if (res.error) {
      toast({ title: res.error });
      return;
    }
    setWsName("");
    toast({ title: `Workspace “${res.workspace.name}” created.` });
    await loadAll();
  }

  async function joinWorkspace() {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", code: joinCode }),
    }).then((r) => r.json());
    if (res.error) {
      toast({ title: res.error });
      return;
    }
    setJoinCode("");
    toast({ title: `Joined “${res.workspace.name}”.` });
    await loadAll();
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ---------- SIGNED OUT ----------
  if (!user) {
    return (
      <div className="mx-auto flex max-w-md flex-col px-4 py-14">
        <h1 className="text-2xl font-serif font-semibold tracking-tight">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          An account syncs your research history across devices — and everything you ran anonymously in this browser
          comes with you. No email verification, no credit card.
        </p>
        <form onSubmit={submitAuth} className="mt-6 space-y-3">
          {mode === "register" && (
            <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          )}
          <Input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <Input type="password" required placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <button
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="mt-4 text-center text-sm text-primary hover:underline"
        >
          {mode === "login" ? "No account yet? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    );
  }

  // ---------- SIGNED IN ----------
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-serif font-semibold tracking-tight">{user.name || user.email}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {user.email}
            {claimed != null && claimed > 0 && ` · ${claimed} anonymous thread${claimed > 1 ? "s" : ""} migrated`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={logout}>
          <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
        </Button>
      </header>

      {/* API KEYS (P2-3) */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="h-4.5 w-4.5 text-primary" /> API keys
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Keys call the verified-report API — the same engine, verdicts, and audit trail, over HTTP.{" "}
          <a href="/api-docs" className="text-primary hover:underline">Read the API docs →</a>
        </p>

        {freshKey && (
          <div className="mt-4 rounded-xl border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm font-medium">Copy your key now — it is shown only once.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-3 py-2 font-mono text-[13px]">{freshKey}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(freshKey).then(() => toast({ title: "Copied." }));
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Input placeholder="Key name (e.g. production)" value={keyName} onChange={(e) => setKeyName(e.target.value)} maxLength={60} />
          <Button onClick={createKey} className="shrink-0">
            <Plus className="mr-1 h-4 w-4" /> Create key
          </Button>
        </div>

        {keys.length > 0 && (
          <div className="mt-4 space-y-2">
            {keys.map((k) => (
              <div key={k.id} className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${k.revoked ? "opacity-60" : ""}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {k.revoked ? <X className="h-3.5 w-3.5 text-destructive" /> : <Check className="h-3.5 w-3.5 text-emerald-600" />}
                    {k.name}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{k.prefix}</code>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    created {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
                  </p>
                </div>
                {!k.revoked && (
                  <Button size="sm" variant="ghost" onClick={() => revokeKey(k.id)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* WORKSPACES (P2-2) */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Users className="h-4.5 w-4.5 text-primary" /> Team workspaces
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          A workspace is a shared research library with audit views — runs posted to it are visible to every member,
          with their verdicts, pre-ship scores, and citation audits.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Input placeholder="New workspace name" value={wsName} onChange={(e) => setWsName(e.target.value)} className="max-w-xs" maxLength={80} />
          <Button onClick={createWorkspace} className="shrink-0">
            <Plus className="mr-1 h-4 w-4" /> Create
          </Button>
          <Input placeholder="Invite code to join a team" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} className="max-w-xs" />
          <Button variant="outline" onClick={joinWorkspace} className="shrink-0">
            Join
          </Button>
        </div>

        {workspaces.length > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => router.push(`/w/${w.id}`)}
                className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{w.name}</span>
                  <span className="rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] font-medium uppercase text-primary">{w.role}</span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {w.jobs} shared run{w.jobs === 1 ? "" : "s"} · {w.members} member{w.members === 1 ? "" : "s"} · owner {w.owner}
                </p>
                {w.inviteCode && (
                  <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">invite: {w.inviteCode}</p>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* What the account unlocks */}
      <section className="rounded-2xl border bg-gradient-to-br from-primary/10 to-transparent p-5">
        <h3 className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="h-4 w-4 text-primary" /> What your account unlocks
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li className="flex gap-2"><Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> Cross-device history sync — your threads live on the server, not just this browser</li>
          <li className="flex gap-2"><KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> API keys for programmatic verified reports (court verdicts included)</li>
          <li className="flex gap-2"><Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> Team workspaces with shared, auditable research libraries</li>
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> Anonymous-first forever — an account is optional; the engine stays free and keyless</li>
        </ul>
      </section>
    </div>
  );
}
