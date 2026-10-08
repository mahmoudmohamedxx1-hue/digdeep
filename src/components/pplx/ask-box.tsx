"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, FileText, Gauge, Infinity as InfinityIcon, Loader2, Plus, Settings2, Square, X, BrainCircuit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Magnet } from "@/components/magic";
import type { AdvParams, AttachedDoc } from "@/components/research/types";

export const MODES = [
  { id: "quick", label: "Quick", hint: "≈ 5–10 min", desc: "2 aspects × 1 round · ~8 sources" },
  { id: "standard", label: "Standard", hint: "≈ 10–25 min", desc: "3 aspects × 2 rounds · ~18 sources · 2 in parallel" },
  { id: "deep", label: "Deep", hint: "≈ 40–90 min", desc: "4 aspects × 3 rounds · ~45 sources · red-team + debate" },
  { id: "exhaustive", label: "Exhaustive", hint: "≈ 2–8 hrs", desc: "5 aspects × 3 rounds · up to 120 sources · every check runs" },
  { id: "unlimited", label: "Unlimited", hint: "∞", desc: "No caps — aspects, rounds, sources & time unlimited; runs until self-critique is satisfied" },
] as const;
export const MODE_PARAMS: Record<string, AdvParams> = {
  quick: { breadth: 2, depth: 1, maxSources: 8, maxMinutes: 10 },
  standard: { breadth: 3, depth: 2, maxSources: 18, maxMinutes: 30 },
  deep: { breadth: 4, depth: 3, maxSources: 45, maxMinutes: 180 },
  exhaustive: { breadth: 5, depth: 3, maxSources: 120, maxMinutes: 720 },
  unlimited: { breadth: -1, depth: -1, maxSources: -1, maxMinutes: -1 },
};

const LANGUAGES = ["English", "Arabic", "Chinese", "Spanish", "French", "German"];
const MAX_DOC_CHARS = 120_000;

function AdvRow({
  label, value, min, max, unit, onChange,
}: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  const unlimited = value < 0;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground/90">{label}</span>
        <div className="flex items-center gap-2">
          <span className={`rounded-lg px-2 py-0.5 text-xs font-semibold tabular-nums ${unlimited ? "bg-primary/10 text-primary" : "bg-muted text-foreground"}`}>
            {unlimited ? <InfinityIcon className="h-3.5 w-3.5" /> : `${value}${unit ?? ""}`}
          </span>
          <button
            onClick={() => onChange(unlimited ? Math.max(min, Math.floor((min + max) / 3)) : -1)}
            className={`rounded-lg border px-2 py-0.5 text-[10px] font-medium transition-colors ${unlimited ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            title={unlimited ? "Remove unlimited cap" : "Set unlimited"}
          >
            ∞ {unlimited ? "on" : "off"}
          </button>
        </div>
      </div>
      <Slider
        value={[unlimited ? min : value]}
        min={min}
        max={max}
        step={1}
        disabled={unlimited}
        onValueChange={(v) => onChange(v[0])}
        className={unlimited ? "opacity-40" : ""}
      />
    </div>
  );
}

/** quiet popover section label */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{children}</p>;
}

export function AskBox({
  value, onChange, onSubmit, busy = false, compact = false, autoFocus = false,
  placeholder = "Ask anything…",
  mode, onMode, adv, advTouched, onAdv, language, onLanguage, modelPref, onModelPref,
  showThinking, onShowThinking, onManagePool, stopMode = false, onStop, stopping = false,
  docs, onDocs, inputId,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  compact?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  mode: string;
  onMode: (m: string) => void;
  adv: AdvParams;
  advTouched: boolean;
  onAdv: (a: AdvParams) => void;
  language: string;
  onLanguage: (l: string) => void;
  modelPref: "auto" | "glm" | "pool";
  onModelPref: (m: "auto" | "glm" | "pool") => void;
  showThinking: boolean;
  onShowThinking: (b: boolean) => void;
  onManagePool: () => void;
  /** when true (a run is active in this thread) the submit button becomes a Stop button */
  stopMode?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  /** attached ground-truth documents (P2-3) */
  docs?: AttachedDoc[];
  onDocs?: (docs: AttachedDoc[]) => void;
  /** id for the textarea — enables ⌘K / "/" global focus shortcuts */
  inputId?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const advDirty = advTouched;
  const attached = docs ?? [];

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(compact ? 120 : 200, ta.scrollHeight)}px`;
  }, [value, compact]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? "Standard";
  const canSubmit = value.trim().length >= 3 && !busy;

  const setAdvKey = (key: keyof AdvParams, v: number) => {
    const next = { ...adv, [key]: v };
    onAdv(next);
  };

  const readFiles = async (files: FileList | null) => {
    if (!files || !onDocs) return;
    const next: AttachedDoc[] = [...attached];
    for (const f of Array.from(files).slice(0, 4)) {
      if (next.length >= 4) break;
      if (f.size > 2_000_000) continue; // 2MB safety cap per file
      try {
        const text = await f.text();
        if (!text.trim()) continue;
        next.push({ name: f.name.slice(0, 120), text: text.slice(0, MAX_DOC_CHARS) });
      } catch { /* unreadable file is skipped */ }
    }
    onDocs(next.slice(0, 4));
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="composer-focus group relative rounded-[28px] border border-input bg-card shadow-elev-1">
      <Textarea
        ref={taRef}
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
        placeholder={placeholder}
        aria-label="Research question"
        rows={1}
        className={`resize-none border-0 bg-transparent px-5 pb-1.5 pt-4 text-[16px] leading-[1.6] shadow-none focus-visible:ring-0 placeholder:text-muted-foreground ${compact ? "min-h-[52px]" : "min-h-[64px]"}`}
      />

      {/* attached documents (P2-3) */}
      {attached.length > 0 && (
        <div className="flex flex-wrap gap-2 px-5 pb-1 pt-1">
          {attached.map((d, i) => (
            <span key={i} className="flex h-8 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-xs font-medium">
              <FileText className="h-3.5 w-3.5 text-primary" />
              <span className="max-w-[160px] truncate">{d.name}</span>
              <button
                className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => onDocs?.(attached.filter((_, j) => j !== i))}
                aria-label={`Remove ${d.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* toolbar — tools left, action right (ChatGPT/Claude composer anatomy) */}
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-1.5">
        {/* attach documents */}
        {onDocs && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,.csv,.json,text/plain"
              multiple
              className="hidden"
              onChange={(e) => void readFiles(e.target.files)}
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              className="press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach documents as ground-truth sources"
              title="Attach .txt / .md documents — they become ground-truth sources for this research"
            >
              <Plus className="h-[18px] w-[18px]" strokeWidth={2.2} />
            </button>
          </>
        )}

        {/* research settings — one quiet gear, zero footer noise */}
        <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
          <PopoverTrigger asChild>
            <button
              className={`press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${advDirty || !showThinking ? "text-primary hover:bg-primary/10" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
              aria-label="Research settings"
              title="Research settings — budgets, language, backend, visible thinking"
            >
              <Settings2 className="h-[18px] w-[18px]" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="glass w-[352px] rounded-[20px] p-4" side="top">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold">Research settings</p>
              {advDirty && (
                <button
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                  onClick={() => { onMode(mode); setSettingsOpen(false); }}
                >
                  <X className="h-3 w-3" /> reset to {modeLabel}
                </button>
              )}
            </div>

            <div className="space-y-4">
              {/* visible thinking */}
              <div className="flex items-center justify-between rounded-[12px] border bg-muted/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <BrainCircuit className={`h-4 w-4 ${showThinking ? "text-primary" : "text-muted-foreground"}`} />
                  <div>
                    <p className="text-xs font-medium">Visible thinking</p>
                    <p className="text-[11px] text-muted-foreground">Show raw reasoning while it works</p>
                  </div>
                </div>
                <button
                  onClick={() => onShowThinking(!showThinking)}
                  role="switch"
                  aria-checked={showThinking}
                  aria-label="Toggle visible thinking"
                  className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200 ${showThinking ? "bg-primary" : "bg-muted-foreground/25"}`}
                >
                  <span
                    className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${showThinking ? "left-[21px]" : "left-[3px]"}`}
                    style={{ transitionTimingFunction: "cubic-bezier(0.25,0.1,0.25,1)" }}
                  />
                </button>
              </div>

              {/* backend */}
              <div>
                <SectionLabel>LLM backend — keyless</SectionLabel>
                <div className="space-y-1">
                  {([
                    ["auto", "Auto", "GLM-5.3-Flash → GLM-4.5-Flash → LLM7 → Pollinations"],
                    ["glm", "GLM Flash", "z.ai SDK — always free, no key"],
                    ["pool", "Keyless pool only", "LLM7 / Pollinations / your endpoints"],
                  ] as const).map(([id, label, desc]) => (
                    <button
                      key={id}
                      onClick={() => onModelPref(id)}
                      className={`flex w-full items-start gap-2.5 rounded-[12px] px-3 py-2 text-left transition-colors ${modelPref === id ? "bg-primary/10" : "hover:bg-accent"}`}
                    >
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${modelPref === id ? "bg-primary" : "bg-muted-foreground/30"}`} />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium">{label}</span>
                        <span className="block text-[11px] leading-snug text-muted-foreground">{desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* budgets */}
              <div>
                <SectionLabel>Budgets{advDirty ? " · custom" : ""}</SectionLabel>
                <div className="space-y-4">
                  <AdvRow label="Aspects (breadth)" value={adv.breadth} min={1} max={16} onChange={(v) => setAdvKey("breadth", v)} />
                  <AdvRow label="Rounds per aspect" value={adv.depth} min={1} max={12} onChange={(v) => setAdvKey("depth", v)} />
                  <AdvRow label="Max sources" value={adv.maxSources} min={4} max={300} onChange={(v) => setAdvKey("maxSources", v)} />
                  <AdvRow label="Time budget" value={adv.maxMinutes} min={5} max={1440} unit=" min" onChange={(v) => setAdvKey("maxMinutes", v)} />
                </div>
              </div>

              {/* language */}
              <div className="flex items-center justify-between rounded-[12px] border bg-muted/40 px-3 py-2">
                <div>
                  <p className="text-xs font-medium">Report language</p>
                  <p className="text-[11px] text-muted-foreground">Used for the final report</p>
                </div>
                <select
                  value={language}
                  onChange={(e) => onLanguage(e.target.value)}
                  className="cursor-pointer rounded-lg border border-input bg-background px-2 py-1 text-xs"
                  aria-label="Report language"
                >
                  {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
                </select>
              </div>

              <button
                onClick={() => { setSettingsOpen(false); onManagePool(); }}
                className="flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-dashed py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <Plus className="h-3.5 w-3.5" /> Manage backends &amp; web search
              </button>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                ∞ = truly unlimited — the agent keeps researching until its own self-critique says coverage is
                sufficient (with a hidden 20-round-per-aspect safety ceiling). Aspects run in parallel; honest time estimates update live.
              </p>
            </div>
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex items-center gap-1.5">
          {/* depth pill — grouped with the action cluster for visual balance */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="press-scale hidden h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex">
                <Gauge className="h-4 w-4 text-primary/70" />
                {modeLabel}
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="glass w-72 rounded-[18px]">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Research depth</DropdownMenuLabel>
              {MODES.map((m) => (
                <DropdownMenuItem key={m.id} onClick={() => onMode(m.id)} className={`gap-2 rounded-[10px] ${mode === m.id ? "bg-primary/10" : ""}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {m.id === "unlimited" && <InfinityIcon className="h-3.5 w-3.5 text-primary" />}
                      {m.label}
                      <span className="text-[10px] font-normal text-muted-foreground">{m.hint}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground">{m.desc}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* submit / stop — 36px circle. Ink when ready, clearly muted when not. */}
          {stopMode && onStop && !canSubmit ? (
            <Button
              size="icon"
              onClick={onStop}
              disabled={stopping}
              aria-label="Stop responding"
              title="Stop the running research / response"
              className="press-scale h-9 w-9 shrink-0 rounded-full bg-foreground text-background shadow-elev-2 hover:bg-foreground/85"
            >
              {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
            </Button>
          ) : (
            <>
              {stopMode && onStop && (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={onStop}
                  disabled={stopping}
                  aria-label="Stop responding"
                  title="Stop the running research / response"
                  className="press-scale h-9 w-9 shrink-0 rounded-full border-input text-muted-foreground hover:text-foreground"
                >
                  {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3 w-3.5 fill-current" />}
                </Button>
              )}
              <Magnet className="shrink-0" maxPull={3} pad={22}>
                <Button
                  size="icon"
                  onClick={() => canSubmit && onSubmit()}
                  disabled={!canSubmit}
                  aria-label="Start research"
                  className={`press-scale spring-pop relative h-9 w-9 shrink-0 overflow-hidden rounded-full border-0 transition-all duration-200 ${
                    canSubmit
                      ? "bg-foreground text-background shadow-elev-2 hover:bg-foreground/85"
                      : "bg-transparent text-muted-foreground/60 hover:bg-muted/60"
                  }`}
                  style={{ transitionTimingFunction: "cubic-bezier(0.25,0.1,0.25,1)" }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />}
                  {canSubmit && !busy && <span className="btn-sheen" aria-hidden />}
                </Button>
              </Magnet>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
