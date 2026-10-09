"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck, Scale, ShieldCheck, Sparkles } from "lucide-react";
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
  const settings = useSettings();

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
    if (question.length < 3) {
      toast({ title: "Please enter a research question first", variant: "destructive" });
      return;
    }
    setStarting(true);
    const res = await startResearchRun({ query: question, threadId: null, docs: withDocs ?? docs });
    setStarting(false);
    if ("error" in res) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    setQuery("");
    setDocs([]);
    void refreshHistory();
    router.push(`/r/${res.threadId}`);
  };

  return (
    <div className="relative flex min-h-full w-full flex-col items-center justify-center overflow-visible px-4 py-12 sm:py-16">
      <div aria-hidden className="dot-grid inset-x-0 top-0 h-[440px]" />
      <AuroraHero />
      <div className="relative z-10 flex w-full max-w-[768px] flex-col items-center text-center">
        <span className="badge-aurora rise-in h-8 items-center gap-1.5 rounded-full px-3.5 text-[11.5px] font-medium text-foreground/85">
          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          Free &amp; open-source deep research
        </span>
        <h1 className="rise-in mt-4 text-balance text-[30px] font-semibold leading-[1.15] tracking-[-0.032em] text-foreground [animation-delay:120ms] sm:text-[31px]">
          {greeting()}
        </h1>
        <p className="rise-in mt-2 font-serif text-[19.5px] leading-snug text-muted-foreground [animation-delay:220ms]">
          What should we dig into?
        </p>
      </div>

      {/* the composer — the star; its focus glow is the one deliberate moment */}
      <div className="group/composer rise-in relative z-10 mt-7 w-full max-w-[768px] [animation-delay:340ms]">
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
          onManagePool={() => window.dispatchEvent(new CustomEvent("digdeep:open-backends"))}
          docs={docs}
          onDocs={setDocs}
          inputId="ask-input"
          placeholderStream={EXAMPLE_STREAM}
        />
        <p className="rise-in relative z-10 mt-3.5 text-center text-[12.5px] font-medium leading-relaxed text-muted-foreground [animation-delay:440ms]">
          Free &amp; keyless · every claim cited · every citation audited · honest quality scores
        </p>
        <p className="kbd-hints relative z-10 mt-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><kbd>/</kbd> focus</span>
          <span className="inline-flex items-center gap-1"><kbd>⌘K</kbd> commands</span>
          <span className="inline-flex items-center gap-1"><kbd>N</kbd> new research</span>
          <span className="inline-flex items-center gap-1"><kbd>J</kbd>/<kbd>K</kbd> claim evidence</span>
        </p>
      </div>

      {/* starter chips — spotlight pills that wake under the cursor */}
      <div className="relative z-10 mt-7 flex w-full max-w-[768px] flex-wrap items-center justify-center gap-2">
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
