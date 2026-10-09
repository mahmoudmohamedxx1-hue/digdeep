"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Compass, LibraryBig, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StaggerIn } from "@/components/magic";
import { deleteThread, deleteTurn, clearAll } from "@/lib/idb-store";
import { useHistory, refreshHistory } from "@/lib/store";
import { groupHistory } from "@/lib/history-group";
import { toast } from "@/hooks/use-toast";

export default function LibraryPage() {
  const router = useRouter();
  const { history } = useHistory();
  const [q, setQ] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [loaded, setLoaded] = useState(false); // false = first load in flight

  useEffect(() => {
    let alive = true;
    refreshHistory().finally(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? history.filter((h) => h.query.toLowerCase().includes(needle)) : history;
  }, [history, q]);
  const grouped = useMemo(() => groupHistory(filtered), [filtered]);

  const open = (h: (typeof history)[number]) => router.push(h.threadId ? `/r/${h.threadId}` : `/r/${h.id}`);

  const remove = async (h: (typeof history)[number]) => {
    if (h.threadId) await deleteThread(h.threadId);
    else await deleteTurn(h.id);
    await refreshHistory();
    toast({ title: "Deleted from this browser", description: "Server copies (if any) are not affected for other users." });
  };

  const clearEverything = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3500);
      return;
    }
    await clearAll();
    await refreshHistory();
    setConfirmClear(false);
    toast({ title: "Browser storage cleared" });
  };

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pb-24 pt-10 sm:pt-14">
      <div className="flex items-center gap-2">
        <LibraryBig className="h-4 w-4 text-primary" />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Library</h1>
        <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">{history.length} saved</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        Every thread, report and source — saved in this browser (IndexedDB). Private to you; survives server restarts.
      </p>

      {history.length > 0 && (
        <div className="relative mt-5">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your threads…"
            className="h-11 rounded-[16px] pl-10"
            aria-label="Search threads"
          />
        </div>
      )}

      {/* loading skeletons — never flash the empty state while IndexedDB reads */}
      {!loaded && (
        <div className="mt-6 space-y-2" aria-label="Loading your threads" role="status">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="surface-card flex items-start gap-2 rounded-[16px] p-3.5">
              <div className="flex-1 space-y-2">
                <div className={`skeleton-line h-4 rounded-full ${i % 3 === 0 ? "w-3/4" : "w-2/3"}`} />
                <div className="skeleton-line h-3 w-1/3 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* designed empty state */}
      {loaded && history.length === 0 && (
        <div className="mt-12 flex flex-col items-center gap-4 py-16 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-primary/10 text-primary">
            <Compass className="h-8 w-8" strokeWidth={1.8} />
          </span>
          <div>
            <p className="text-[15px] font-semibold">Nothing dug yet</p>
            <p className="mx-auto mt-1.5 max-w-[300px] text-[12.5px] leading-relaxed text-muted-foreground">
              Threads you start are saved here in this browser — reports, sources and thinking included.
            </p>
          </div>
          <Button className="press-scale rounded-full" onClick={() => router.push("/")}>
            Start your first research
          </Button>
        </div>
      )}

      {/* no search hits */}
      {loaded && history.length > 0 && filtered.length === 0 && (
        <div className="mt-12 flex flex-col items-center gap-3 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-muted text-muted-foreground">
            <Search className="h-6 w-6" strokeWidth={1.8} />
          </span>
          <p className="text-sm font-semibold">No threads match “{q}”</p>
          <p className="text-[12px] text-muted-foreground">Try a shorter search — matching runs against your question text.</p>
        </div>
      )}

      {/* time-grouped threads */}
      {loaded && (
      <div className="mt-6 space-y-6">
        {grouped.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">{g.label}</p>
            <div className="space-y-2">
              {g.items.map((h, i) => (
                <StaggerIn key={h.id} index={Math.min(i, 8)} y={6}>
                  <div className="surface-card hover-lift group relative flex items-start gap-2 rounded-[16px] p-3.5">
                    <button onClick={() => open(h)} className="min-w-0 flex-1 text-left">
                      <p dir="auto" className="line-clamp-2 text-sm font-medium">{h.query}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span className={`rounded-md px-2 py-0.5 font-medium capitalize ${h.status === "completed" ? "bg-primary/10 text-primary" : h.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted"}`}>
                          {h.status}
                        </span>
                        <span className="capitalize">{h.mode === "chat" ? "chat" : h.mode === "quick" ? "quick answer" : h.preset}</span>
                        <span>{new Date(h.createdAt).toLocaleString()}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => void remove(h)}
                      className="shrink-0 rounded-lg p-1.5 text-muted-foreground/50 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={h.threadId ? "Delete this thread from this browser" : "Delete from this browser"}
                      title={h.threadId ? "Delete this thread from this browser" : "Delete from this browser"}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </StaggerIn>
              ))}
            </div>
          </section>
        ))}
      </div>
      )}

      {loaded && history.length > 0 && (
        <Button
          variant="outline"
          className={`press-scale mt-8 w-full gap-2 rounded-[12px] ${confirmClear ? "border-destructive/50 text-destructive hover:text-destructive" : "text-destructive hover:text-destructive"}`}
          onClick={() => void clearEverything()}
        >
          <Trash2 className="h-4 w-4" />
          {confirmClear ? "Tap again to confirm — this cannot be undone" : "Clear all browser data"}
        </Button>
      )}
    </div>
  );
}
