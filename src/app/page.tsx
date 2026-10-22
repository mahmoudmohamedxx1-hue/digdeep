"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck, Lock, Scale, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { AskBox } from "@/components/pplx/ask-box";
import { AuroraHero, SpotlightCard, StaggerIn } from "@/components/magic";
import type { AttachedDoc } from "@/components/research/types";
import { useSettings, refreshHistory } from "@/lib/store";
import { startResearchRun } from "@/lib/research-client";

/** One-tap starter chips — short enough to wear as pills, sharp enough to be real research. */
const SUGGESTIONS: { icon: LucideIcon; label: string }[] = [
  { icon: BadgeCheck, label: "How honest are AI citations?" },
  { icon: Scale, label: "Is Rust replacing C++ yet?" },
  { icon: ShieldCheck, label: "What breaks if TLS PKI rotates?" },
  { icon: Sparkles, label: "What's new in deep research?" },
];

/** Idle-placeholder rotation — the empty composer keeps demonstrating what it can do. */
const EXAMPLE_STREAM = [
  "Ask anything…",
  "Is Rust actually replacing C++ in production?",
  "What really broke the last time a root CA rotated?",
  "How honest are AI citations, honestly?",
  "Are small modular reactor economics finally working?",
  "What's new in deep research engines?",
];

/** Time-aware greeting — the room always knows what time it is. */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<AttachedDoc[]>([]);
  const [starting, setStarting] = useState(false);
  // v3.6: chatting needs an account — track the session so the composer can
  // say so BEFORE the user types (the server gate is the real enforcement;
  // this is only the polite heads-up).
  const [signedOut, setSignedOut] = useState(false);
  const settings = useSettings();

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => setSignedOut(!d.user))
      .catch(() => setSignedOut(false)); // offline/fetch failure: let the server gate speak
  }, []);

  // legacy deep links: /?t=<threadId> → /r/<threadId>; Discover prefill → composer
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) {
      router.replace(`/r/${encodeURIComponent(t)}`);
      return;
    }
    try {
      const prefill = sessionStorage.getItem("digdeep:prefill");
      if (prefill) {
        sessionStorage.removeItem("digdeep:prefill");
        requestAnimationFrame(() => setQuery(prefill));
      }
    } catch { /* ignore */ }
  }, [router]);

  const start = async (q?: string, withDocs?: AttachedDoc[]) => {
    const question = (q ?? query).trim();
    if (question.length < 2) { // v3.0.2: 2-char floor — "hi" is a greeting the trivial-guard answers instantly
      toast({ title: "Please enter a research question first", variant: "destructive" });
      return;
    }
    setStarting(true);
    const res = await startResearchRun({ query: question, threadId: null, docs: withDocs ?? docs });
    setStarting(false);
    if ("error" in res) {
      if (res.authRequired) {
        // v3.6 sign-in gate — take the question with us so /account can send
        // the user straight back (the composer draft is preserved below via ?next=/)
        toast({ title: "Sign in to chat — one email code, no password." });
        router.push("/account?next=%2F");
        return;
      }
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    setQuery("");
    setDocs([]);
    void refreshHistory();
    router.push(`/r/${res.threadId}`);
  };

  return (
    // overflow-x-clip: the AuroraHero bleeds ±240px past the column; without
    // the clip that bleed widens the document beyond the viewport, and on
    // touch a left-swipe pans the whole page sideways. Clip kills the pan
    // (v2.0.5); vertical stays visible so glows/hovers are untouched.
    <div className="relative flex min-h-full w-full flex-col items-center justify-center overflow-x-clip px-4 py-12 sm:py-16">
      <div aria-hidden className="dot-grid inset-x-0 top-0 h-[440px]" />
      <AuroraHero />
      <div className="relative z-10 flex w-full max-w-[max(min(812px,88%),420px)] flex-col items-center text-center">
        <span className="badge-aurora rise-in h-8 items-center gap-1.5 rounded-full px-3.5 text-[11.5px] font-medium text-foreground/85">
          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          The research tool that puts its own answer on trial
        </span>
        <h1 className="rise-in mt-4 text-balance text-[30px] font-semibold leading-[1.15] tracking-[-0.032em] text-foreground [animation-delay:120ms] sm:text-[31px]">
          {greeting()}
        </h1>
        <p className="rise-in mt-2 font-serif text-[19.5px] leading-snug text-muted-foreground [animation-delay:220ms]">
          What should we dig into?
        </p>
        <p className="rise-in mt-2.5 max-w-lg text-[13px] leading-relaxed text-muted-foreground/90 [animation-delay:280ms]">
          A prosecutor, a defense, and 12 jurors cross-examine every answer · every claim checked against its source ·{" "}
          <a href="/benchmark" className="text-primary hover:underline">we publish our benchmark scores and failures</a>
        </p>
      </div>

      {/* the composer — the star; its focus glow is the one deliberate moment */}
      <div className="group/composer rise-in relative z-10 mt-7 w-full max-w-[max(min(812px,88%),420px)] [animation-delay:340ms]">
        <div aria-hidden className="composer-glow opacity-70 transition-opacity duration-500 group-focus-within/composer:opacity-100" />
        <AskBox
          value={query}
          onChange={setQuery}
          onSubmit={() => void start()}
          busy={starting}
          autoFocus
          placeholder="Ask anything…"
          mode={settings.mode}
          onMode={settings.applyMode}
          adv={settings.adv}
          advTouched={settings.advTouched}
          onAdv={settings.changeAdv}
          language={settings.language}
          onLanguage={settings.setLanguage}
          modelPref={settings.modelPref}
          onModelPref={settings.setModelPref}
          showThinking={settings.showThinking}
          onShowThinking={settings.setShowThinking}
          court={settings.court}
          onCourt={settings.setCourt}
          domain={settings.domain}
          onDomain={settings.setDomain}
          onManagePool={() => window.dispatchEvent(new CustomEvent("digdeep:open-settings"))}
          docs={docs}
          onDocs={setDocs}
          inputId="ask-input"
          placeholderStream={EXAMPLE_STREAM}
        />
        {/* v3.6 sign-in gate — the polite heads-up under the composer. The
            composer stays open (landing page stays inviting); submitting
            without a session routes to /account and straight back after. */}
        {signedOut && (
          <div className="relative z-10 mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-2.5 text-[12.5px] text-muted-foreground">
            <Lock className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span>
              Chatting needs a free account —{" "}
              <Link href="/account?next=%2F" className="font-medium text-primary hover:underline">sign in with an email code</Link>
            </span>
          </div>
        )}
        <p className="rise-in relative z-10 mt-3.5 text-center text-[12.5px] font-medium leading-relaxed text-muted-foreground [animation-delay:440ms]">
          Free · no LLM keys needed · every claim cited &amp; audited · honest WITHHELD verdicts · exports with the evidence ledger
        </p>
        <p className="rise-in relative z-10 mt-1.5 text-center text-[11.5px] text-muted-foreground/80 [animation-delay:480ms]">
          <a href="/gallery" className="hover:text-foreground hover:underline">Explore the report gallery</a>
          {" · "}
          <a href="/api-docs" className="hover:text-foreground hover:underline">Verified-report API</a>
        </p>
        <p className="kbd-hints relative z-10 mt-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><kbd>/</kbd> focus</span>
          <span className="inline-flex items-center gap-1"><kbd>⌘K</kbd> commands</span>
          <span className="inline-flex items-center gap-1"><kbd>N</kbd> new research</span>
          <span className="inline-flex items-center gap-1"><kbd>J</kbd>/<kbd>K</kbd> claim evidence</span>
        </p>
      </div>

      {/* starter chips — spotlight pills that wake under the cursor */}
      <div className="relative z-10 mt-7 flex w-full max-w-[max(min(812px,88%),420px)] flex-wrap items-center justify-center gap-2">
        {SUGGESTIONS.map((s, i) => (
          <StaggerIn key={s.label} index={i} enterDelay={0.5} className="inline-flex">
            <SpotlightCard size={190} className="rounded-full">
              <button
                onClick={() => { setQuery(s.label); document.getElementById("ask-input")?.focus(); }}
                className="press-scale group inline-flex h-10 max-w-full items-center gap-2 rounded-full border border-border/90 bg-card px-4 text-[13px] font-medium text-foreground/80 shadow-elev-1 transition-all duration-200 hover:border-primary/35 hover:bg-accent/40 hover:text-foreground"
              >
                <s.icon className="h-4 w-4 shrink-0 text-primary/85" strokeWidth={2.1} />
                <span className="truncate">{s.label}</span>
              </button>
            </SpotlightCard>
          </StaggerIn>
        ))}
      </div>
    </div>
  );
}
