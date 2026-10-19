"use client";

import * as React from "react";
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { clearAll } from "@/lib/idb-store";

/**
 * THREAD ERROR BOUNDARY (v3.0.2)
 *
 * Found by the live audit: a single malformed court record (or any future bad
 * data shape) cached in IndexedDB hard-crashed the WHOLE thread page — Next.js
 * replaced it with the white "Application error" screen, and because the poison
 * lived in the browser's local cache (not the server), deleting server rows
 * could not fix it. The user was stuck on that thread forever.
 *
 * This boundary catches the crash at the turns column instead: the shell, rail
 * and composer survive, and the fallback card offers the two real escapes —
 * plain reload, or "reset local cache & reload" (clears the IndexedDB turn/
 * thread stores — user prefs are NOT touched — then reloads; the server still
 * has every completed run, so nothing is lost).
 */
interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
  resetting: boolean;
}

export class ThreadErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetting: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  private resetCache = async () => {
    this.setState({ resetting: true });
    try {
      await clearAll();
    } catch {
      // even if the cache clear fails, a reload is still the best next step
    }
    try {
      window.location.reload();
    } catch {
      this.setState({ resetting: false });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { resetting } = this.state;
    return (
      <div className="mx-auto w-full max-w-[max(min(812px,88%),420px)] pt-10">
        <div className="rounded-[20px] border border-[#ff9f0a]/35 bg-[#ff9f0a]/[0.05] p-6">
          <p className="flex items-center gap-2.5 text-[15px] font-semibold">
            <AlertTriangle className="h-4.5 w-4.5 shrink-0 text-[#b25000] dark:text-[#ff9f0a]" aria-hidden />
            Something in this thread&apos;s local data broke the page
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Your research is safe on the server — this is a local display problem, most likely a
            cached turn this build cannot render. Reload first; if it keeps happening, reset the
            local cache: the thread is re-fetched from the server (saved preferences and other
            threads are not touched).
          </p>
          {this.state.error.message && (
            <p className="mt-2.5 truncate rounded-lg bg-card/70 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/80" title={this.state.error.message}>
              {this.state.error.message}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="press-scale inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-card px-4 text-[13px] font-medium hover:bg-muted/60"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload
            </button>
            <button
              type="button"
              onClick={() => void this.resetCache()}
              disabled={resetting}
              className="press-scale inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-[13px] font-medium text-background disabled:opacity-60"
            >
              {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
              {resetting ? "Resetting…" : "Reset local cache & reload"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
