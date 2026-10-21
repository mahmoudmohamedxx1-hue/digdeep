"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Copy, KeyRound, LogOut, Plus, RefreshCw, Scale, ShieldCheck, Users, Check, X, Webhook, Eye, Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "@/hooks/use-toast";
import { getThreadTurns } from "@/lib/idb-store";
import { useSettings } from "@/lib/store";

/**
 * P1-1 / P2-2 / P2-3 / v3.4 — Account: sign in / register (with anonymous-history
 * migration), API keys (scopes + monthly quotas), team workspaces, webhooks,
 * and scheduled watches.
 */

const ALL_SCOPES = [
  ["research:read", "read runs & reports"],
  ["research:write", "start runs"],
  ["webhooks", "manage webhooks"],
  ["watches", "manage scheduled watches"],
] as const;

const ALL_EVENTS = ["run.completed", "run.failed", "watch.changed"] as const;

type SessionUser = { id: string; email: string; name: string | null; isAdmin?: boolean };
type ApiKeyRow = { id: string; name: string; prefix: string; revoked: boolean; lastUsedAt: string | null; createdAt: string; scopes: string[]; monthlyLimit: number | null; usage: number | null };
type WorkspaceRow = { id: string; name: string; role: string; inviteCode: string | null; owner: string; jobs: number; members: number; createdAt: string };
type DeliveryRow = { id: string; event: string; ok: boolean; status: number | null; error: string | null; createdAt: string };
type WebhookRow = { id: string; url: string; events: string[]; active: boolean; secret: string; createdAt: string; recentDeliveries: DeliveryRow[] };
type WatchRow = { id: string; query: string; preset: string; court: boolean; cadenceDays: number; active: boolean; lastRunId: string | null; lastVerdict: string | null; lastChangedAt: string | null; nextRunAt: string; createdAt: string };

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  // auth form
  const [mode, setMode] = useState<"login" | "register" | "code">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // email-code (OTP) sign-in — v3.5
  const [otpOn, setOtpOn] = useState(false); // deployment supports email codes
  const [otpSent, setOtpSent] = useState(false); // a code was requested for $email
  const [otpCode, setOtpCode] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0); // resend cooldown, seconds
  // api keys
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>(ALL_SCOPES.map(([s]) => s));
  const [keyLimit, setKeyLimit] = useState("");
  // webhooks
  const [hooks, setHooks] = useState<WebhookRow[]>([]);
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<string[]>(["run.completed"]);
  // watches
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [watchQuery, setWatchQuery] = useState("");
  const [watchCadence, setWatchCadence] = useState("7");
  const [watchCourt, setWatchCourt] = useState(false);
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
      setOtpOn(!!(res as { otpEnabled?: boolean }).otpEnabled);
      if (u) {
        const [k, w, h, wt] = await Promise.all([
          fetch("/api/keys").then((r) => r.json()),
          fetch("/api/workspaces").then((r) => r.json()),
          fetch("/api/webhooks").then((r) => r.json()),
          fetch("/api/watches").then((r) => r.json()),
        ]);
        setKeys(k.keys ?? []);
        setWorkspaces(w.workspaces ?? []);
        setHooks(h.webhooks ?? []);
        setWatches(wt.watches ?? []);
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

  // resend-code countdown (v3.5)
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1_000);
    return () => clearTimeout(t);
  }, [resendIn]);

  /** v3.5: ask the backend to email a 6-digit sign-in code to $email. */
  async function sendCode(e?: React.MouseEvent) {
    e?.preventDefault();
    if (!email.includes("@")) {
      toast({ title: "Enter your email address first." });
      return;
    }
    setOtpBusy(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "otp-send", email: email.trim().toLowerCase() }),
      }).then((r) => r.json());
      if (res.error) {
        toast({ title: res.error });
        return;
      }
      setOtpSent(true);
      setOtpCode("");
      setResendIn(60);
      toast({ title: res.message ?? "Code sent — check your inbox (and spam folder)." });
    } catch {
      toast({ title: "Could not send the code — check your connection." });
    } finally {
      setOtpBusy(false);
    }
  }

  /** v3.5: confirm the code → signed in (a brand-new address gets an account). */
  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (otpCode.length !== 6) {
      toast({ title: "Enter the 6-digit code from your email." });
      return;
    }
    setOtpBusy(true);
    try {
      const claimThreadIds = await localThreadIds();
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "otp-verify",
          email: email.trim().toLowerCase(),
          code: otpCode,
          claimThreadIds,
        }),
      }).then((r) => r.json());
      if (res.error) {
        toast({ title: res.error });
        return;
      }
      setUser(res.user);
      setClaimed(res.claimed ?? 0);
      if (res.claimed > 0) {
        toast({
          title: `Welcome — ${res.claimed} of your anonymous research thread${res.claimed > 1 ? "s" : ""} now sync to this account.`,
        });
      }
      await loadAll();
    } catch {
      toast({ title: "Sign-in failed — check your connection." });
    } finally {
      setOtpBusy(false);
    }
  }

  /** Clear code-entry state (the email stays for the next attempt). */
  function resetOtp() {
    setOtpSent(false);
    setOtpCode("");
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
    setHooks([]);
    setWatches([]);
    toast({ title: "Signed out. Your local history stays in this browser." });
  }

  async function createKey() {
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: keyName || "default",
        scopes: keyScopes,
        monthlyLimit: keyLimit === "" ? undefined : Number(keyLimit),
      }),
    }).then((r) => r.json());
    if (res.error) {
      toast({ title: res.error });
      return;
    }
    setFreshKey(res.key);
    setKeyName("");
    setKeyLimit("");
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

  async function hookAction(body: Record<string, unknown>) {
    const res = await fetch("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (res.error) {
      toast({ title: res.error });
      return null;
    }
    await loadAll();
    return res;
  }

  async function createWebhook() {
    const res = await hookAction({ action: "create", url: hookUrl, events: hookEvents });
    if (res) {
      setHookUrl("");
      toast({ title: "Webhook registered — keep the signing secret for verification." });
    }
  }

  async function watchAction(body: Record<string, unknown>) {
    const res = await fetch("/api/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (res.error) {
      toast({ title: res.error });
      return null;
    }
    await loadAll();
    return res;
  }

  async function createWatch() {
    const res = await watchAction({
      action: "create",
      query: watchQuery,
      cadenceDays: Number(watchCadence) || 7,
      court: watchCourt,
    });
    if (res) {
      setWatchQuery("");
      toast({ title: "Watch scheduled — first run at the next scheduler tick." });
    }
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
          {mode === "code" ? "Sign in with an email code" : mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          An account syncs your research history across devices — and everything you ran anonymously in this browser
          comes with you. Password or one-time email code — no credit card.
        </p>

        {mode === "code" ? (
          <form onSubmit={verifyCode} className="mt-6 space-y-3">
            <Input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={otpSent}
            />
            {otpSent && (
              <div className="space-y-2">
                <InputOTP maxLength={6} value={otpCode} onChange={setOtpCode} autoFocus>
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
                <p className="text-xs text-muted-foreground">
                  Enter the 6-digit code emailed to {email}. Wrong code? Request a new one — codes expire.
                </p>
              </div>
            )}
            {!otpSent ? (
              <Button type="button" disabled={otpBusy || !email.includes("@")} className="w-full" onClick={sendCode}>
                {otpBusy ? "Sending…" : "Email me a code"}
              </Button>
            ) : (
              <div className="space-y-2">
                <Button type="submit" disabled={otpBusy || otpCode.length !== 6} className="w-full">
                  {otpBusy ? "Verifying…" : "Verify & sign in"}
                </Button>
                <div className="flex items-center justify-between text-xs">
                  <button type="button" className="text-primary hover:underline" onClick={resetOtp}>
                    Use a different email
                  </button>
                  <button
                    type="button"
                    className="text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:text-muted-foreground"
                    disabled={resendIn > 0 || otpBusy}
                    onClick={sendCode}
                  >
                    {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                  </button>
                </div>
              </div>
            )}
          </form>
        ) : (
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
        )}

        <div className="mt-4 space-y-1 text-center text-sm">
          {otpOn && mode !== "code" && (
            <button
              type="button"
              onClick={() => {
                setMode("code");
                resetOtp();
              }}
              className="block w-full text-primary hover:underline"
            >
              Sign in with an email code instead
            </button>
          )}
          {mode !== "login" && (
            <button type="button" onClick={() => setMode("login")} className="block w-full text-primary hover:underline">
              Sign in with a password
            </button>
          )}
          {mode === "login" && (
            <button type="button" onClick={() => setMode("register")} className="block w-full text-primary hover:underline">
              No account yet? Create one
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---------- SIGNED IN ----------
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-serif font-semibold tracking-tight">
            {user.name || user.email}
            {user.isAdmin && (
              <span
                title="Operator account — can manage the LLM pool, endpoint keys, and search providers from the Backends console."
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-sans font-medium tracking-wide text-primary"
              >
                <ShieldCheck className="h-3 w-3" /> ADMIN
              </span>
            )}
          </h1>
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

        <div className="mt-4 rounded-xl border p-4">
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Key name (e.g. production)" value={keyName} onChange={(e) => setKeyName(e.target.value)} maxLength={60} className="max-w-xs" />
            <Input
              type="number" min={1} placeholder="Monthly run cap (optional)"
              value={keyLimit} onChange={(e) => setKeyLimit(e.target.value)} className="max-w-[200px]"
            />
            <Button onClick={createKey} className="shrink-0">
              <Plus className="mr-1 h-4 w-4" /> Create key
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {ALL_SCOPES.map(([scope, label]) => (
              <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                  checked={keyScopes.includes(scope)}
                  onChange={(e) =>
                    setKeyScopes((prev) => (e.target.checked ? [...prev, scope] : prev.filter((s) => s !== scope)))
                  }
                />
                <code className="font-mono">{scope}</code> · {label}
              </label>
            ))}
          </div>
        </div>

        {keys.length > 0 && (
          <div className="mt-4 space-y-2">
            {keys.map((k) => (
              <div key={k.id} className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${k.revoked ? "opacity-60" : ""}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {k.revoked ? <X className="h-3.5 w-3.5 text-destructive" /> : <Check className="h-3.5 w-3.5 text-emerald-600" />}
                    {k.name}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{k.prefix}</code>
                    {(k.scopes ?? []).filter((s) => s !== "research:read").map((s) => (
                      <span key={s} className="rounded-full border border-primary/25 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] text-primary">{s}</span>
                    ))}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    created {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
                    {k.monthlyLimit != null && k.usage != null && ` · ${k.usage}/${k.monthlyLimit} runs this month`}
                    {k.monthlyLimit != null && k.usage == null && ` · capped at ${k.monthlyLimit} runs/month`}
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

      {/* WEBHOOKS (v3.4) */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Webhook className="h-4.5 w-4.5 text-primary" /> Webhooks
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          DigDeep POSTs to your endpoints when runs finish or watched verdicts change — signed with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">X-DigDeep-Signature: sha256=HMAC(secret, timestamp.body)</code>.{" "}
          <a href="/api-docs" className="text-primary hover:underline">Verification examples →</a>
        </p>
        <div className="mt-4 rounded-xl border p-4">
          <div className="flex flex-wrap gap-2">
            <Input
              type="url" placeholder="https://your-app.example.com/hook"
              value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} className="min-w-[240px] flex-1"
            />
            <Button onClick={createWebhook} className="shrink-0" disabled={!hookUrl.trim()}>
              <Plus className="mr-1 h-4 w-4" /> Add webhook
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {ALL_EVENTS.map((ev) => (
              <label key={ev} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                  checked={hookEvents.includes(ev)}
                  onChange={(e) =>
                    setHookEvents((prev) => (e.target.checked ? [...new Set([...prev, ev])] : prev.filter((x) => x !== ev)))
                  }
                />
                <code className="font-mono">{ev}</code>
              </label>
            ))}
          </div>
        </div>
        {hooks.length > 0 && (
          <div className="mt-4 space-y-2">
            {hooks.map((h) => (
              <div key={h.id} className={`rounded-xl border p-3 ${h.active ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {h.active ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <X className="h-3.5 w-3.5 text-muted-foreground" />}
                      <span className="truncate font-mono text-[12px]">{h.url}</span>
                      {h.events.map((ev) => (
                        <span key={ev} className="rounded-full border border-primary/25 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] text-primary">{ev}</span>
                      ))}
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={`secret: ${h.secret}`}>
                      secret: {h.secret.slice(0, 10)}…
                    </p>
                    {h.recentDeliveries.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        last delivery: {h.recentDeliveries[0].ok ? "✓" : "✗"} {h.recentDeliveries[0].event}
                        {h.recentDeliveries[0].status ? ` · HTTP ${h.recentDeliveries[0].status}` : ""}
                        {h.recentDeliveries[0].error ? ` · ${h.recentDeliveries[0].error.slice(0, 60)}` : ""}
                        {" · "}{new Date(h.recentDeliveries[0].createdAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => hookAction({ action: "update", id: h.id, active: !h.active })}>
                      {h.active ? "Pause" : "Resume"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => hookAction({ action: "rotate-secret", id: h.id })}>
                      Rotate
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => hookAction({ action: "delete", id: h.id })}>
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* WATCHED RESEARCH (v3.4) */}
      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Eye className="h-4.5 w-4.5 text-primary" /> Watched research
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Schedule a question and DigDeep re-verifies it on a cadence — when the verdict or the evidence set changes,
          you get a <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">watch.changed</code> webhook with
          the previous and current verdicts.
        </p>
        <div className="mt-4 rounded-xl border p-4">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="A question worth re-checking (e.g. current EV market-share leader?)"
              value={watchQuery} onChange={(e) => setWatchQuery(e.target.value)} maxLength={600}
              className="min-w-[240px] flex-1"
            />
            <Input
              type="number" min={1} max={90} title="cadence in days"
              value={watchCadence} onChange={(e) => setWatchCadence(e.target.value)} className="w-24"
            />
            <Button onClick={createWatch} className="shrink-0" disabled={!watchQuery.trim()}>
              <Plus className="mr-1 h-4 w-4" /> Watch
            </Button>
          </div>
          <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
            <input
              type="checkbox" className="h-3.5 w-3.5 accent-[var(--primary)]"
              checked={watchCourt} onChange={(e) => setWatchCourt(e.target.checked)}
            />
            put each refresh on trial (court verdict tracking)
          </label>
        </div>
        {watches.length > 0 && (
          <div className="mt-4 space-y-2">
            {watches.map((w) => (
              <div key={w.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${w.active ? "" : "opacity-60"}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {w.active ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <X className="h-3.5 w-3.5 text-muted-foreground" />}
                    <span className="truncate">{w.query}</span>
                    {w.court && (
                      <span className="rounded-full border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[10px] text-primary">court</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    every {w.cadenceDays}d · last: {w.lastVerdict ?? "not yet run"} · next: {new Date(w.nextRunAt).toLocaleString()}
                    {w.lastChangedAt && ` · verdict changed ${new Date(w.lastChangedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => watchAction({ action: "run-now", id: w.id })}>
                    <Play className="mr-1 h-3 w-3" /> Run now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => watchAction({ action: "update", id: w.id, active: !w.active })}>
                    {w.active ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => watchAction({ action: "delete", id: w.id })}>
                    Delete
                  </Button>
                </div>
              </div>
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
