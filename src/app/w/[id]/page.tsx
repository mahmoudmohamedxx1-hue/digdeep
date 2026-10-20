"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Copy, RefreshCw, Scale, ShieldCheck, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

/**
 * P2-2 WORKSPACE VIEW — /w/<id>
 * The team research library + audit view: every run posted to the workspace,
 * with verdicts, pre-ship scores, citation integrity, and domains — the view
 * a research lead uses to check their team's work.
 */

type LibraryRow = {
  id: string;
  threadId: string | null;
  query: string;
  status: string;
  mode: string;
  court: boolean;
  verdict: string | null;
  reportScore: number | null;
  domain: string;
  preset: string;
  hasReport: boolean;
  createdAt: string;
  completedAt: string | null;
};
type Member = { id: string; name: string; email: string; role: string; joined: string };

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ws, setWs] = useState<{ id: string; name: string; role: string; inviteCode: string | null; owner: string } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${id}`).then((r) => r.json());
      if (res.error) {
        setErr(res.error);
      } else {
        setWs(res.workspace);
        setMembers(res.members ?? []);
        setLibrary(res.library ?? []);
        setErr(null);
      }
    } catch {
      setErr("Could not load the workspace.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (err || !ws) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-lg font-medium">{err ?? "Workspace not found."}</p>
        <p className="mt-2 text-sm text-muted-foreground">Sign in from the Account page and make sure you are a member.</p>
        <Button className="mt-4" onClick={() => router.push("/account")}>Go to Account</Button>
      </div>
    );
  }

  const completed = library.filter((l) => l.status === "completed");
  const avgScore = completed.length && completed.some((c) => c.reportScore != null)
    ? Math.round(completed.reduce((a, c) => a + (c.reportScore ?? 0), 0) / completed.filter((c) => c.reportScore != null).length)
    : null;
  const courtRuns = library.filter((l) => l.court);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/account" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> All workspaces
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-serif font-semibold tracking-tight">{ws.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Owner {ws.owner} · {members.length} member{members.length === 1 ? "" : "s"} · {library.length} shared run{library.length === 1 ? "" : "s"}
          </p>
        </div>
        {ws.inviteCode && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard?.writeText(ws.inviteCode!).then(() => toast({ title: "Invite code copied." }));
            }}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy invite code
          </Button>
        )}
      </header>

      {/* Members */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {members.map((m) => (
            <span key={m.id} className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm">
              {m.name}
              {m.role === "owner" && <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium uppercase text-primary">owner</span>}
            </span>
          ))}
        </div>
      </section>

      {/* Audit stats */}
      {library.length > 0 && (
        <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border bg-card p-3">
            <div className="text-[11px] font-medium text-muted-foreground">SHARED RUNS</div>
            <div className="mt-1 text-xl font-semibold">{library.length}</div>
          </div>
          <div className="rounded-xl border bg-card p-3">
            <div className="text-[11px] font-medium text-muted-foreground">COURT RUNS</div>
            <div className="mt-1 text-xl font-semibold">{courtRuns.length}</div>
          </div>
          <div className="rounded-xl border bg-card p-3">
            <div className="text-[11px] font-medium text-muted-foreground">AVG PRE-SHIP SCORE</div>
            <div className="mt-1 text-xl font-semibold">{avgScore != null ? `${avgScore}/100` : "—"}</div>
          </div>
          <div className="rounded-xl border bg-card p-3">
            <div className="text-[11px] font-medium text-muted-foreground">COMPLETED</div>
            <div className="mt-1 text-xl font-semibold">{completed.length}/{library.length}</div>
          </div>
        </section>
      )}

      {/* The audit view: every run with its verification columns */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Research library — the audit view</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every run shared to this workspace, with the verification numbers a lead needs to check: verdict, pre-ship
          score, and domain. Click a run to open its full report and citation audit.
        </p>
        {library.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No runs posted yet. Start a run with this workspace selected in the composer, or share a completed run
            into it from the thread page.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="p-3">question</th>
                  <th className="p-3">verdict</th>
                  <th className="p-3">pre-ship</th>
                  <th className="p-3">domain</th>
                  <th className="p-3">when</th>
                </tr>
              </thead>
              <tbody>
                {library.map((l) => (
                  <tr key={l.id} className="cursor-pointer border-t hover:bg-muted/30" onClick={() => l.threadId && window.open(`/r/${l.threadId}`, "_blank")}>
                    <td className="max-w-[300px] p-3">
                      <div className="truncate font-medium">{l.query}</div>
                      <div className="text-[11px] text-muted-foreground">{l.preset} · {l.status}</div>
                    </td>
                    <td className="p-3">
                      {l.verdict ? (
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          l.verdict === "GUILTY" ? "bg-rose-500/10 text-rose-600" : l.verdict === "HUNG JURY" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600"
                        }`}>
                          <Scale className="h-3 w-3" /> {l.verdict}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">{l.court ? "pending" : "—"}</span>
                      )}
                    </td>
                    <td className="p-3">
                      {l.reportScore != null ? (
                        <span className={`font-semibold ${l.reportScore >= 75 ? "text-emerald-600" : l.reportScore >= 60 ? "text-amber-600" : "text-rose-600"}`}>
                          {l.reportScore}/100
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Globe className="h-3 w-3" /> {l.domain}
                      </span>
                    </td>
                    <td className="p-3 text-muted-foreground">{new Date(l.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-8 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
        Runs are shared read-only. Personal research never appears here unless you post it.
      </p>
    </div>
  );
}
