# Changelog

## v2.0.3 — more Recents, denser sidebar, chattier threads (2026-10-10)

- **Half the chrome above Recents, twice the list.** Everything above the
  Recents list shrank (header 60→52px, New research 40→36px, nav rows
  44→36px, divider 12→6px, footer 73→53px) and recent rows went 32→28px —
  the visible-threads area grew from ~13-14 to ~19-20 rows at 900px tall,
  while the v2.0.1 alignment grid is untouched (dots and nav icons still
  on the 24px axis). The mobile nav sheet keeps its 44px touch rows and
  now shows each row's delete button always (hover never happens on
  touch — it was invisible on phones).
- **Chat flow, not document flow.** Threads read like a chat now: quiet
  date separators (Today / Yesterday / weekday / date) between turns from
  different days, a timestamp + copy button under every user question
  (hover-reveal on desktop, always on phones), and a completion timestamp
  at the right end of every action bar. Chat replies gained a
  **Regenerate** button next to copy/share.
- **Stop moved into the live status.** The Stop control no longer floats
  as its own right-aligned row above the answer — it's a compact pill
  inside the StepsCard header (next to the elapsed timer) and the chat
  thinking strip, exactly where the live status is. Verified live on a
  real run: clicking it halts the agent at its next checkpoint.
- Turn spacing tightened (40→32px) — the date separators carry the rhythm.

## v2.0.2 — Settings dialog & the original emblem back (2026-10-10)

- **Your logo, restored.** The header mark is once again the uploaded
  topographic "D" emblem — the tight transparent animated WebP (128 frames)
  with the light-mode drop shadow — not the SVG ring that replaced it in
  v2.0's Phase 3. Same for the favicon (dark badge + emblem + status dots:
  green flash while researching, blue when done) and the notification icon.
  The 6px lockup gap and all-wordmark typography from v2.0.1 are kept.
- **One Settings dialog.** "Backends & search" and "Dark mode" are no longer
  loose sidebar footer items: a single **Settings** entry (gear) opens a
  dialog with an **Appearance** section (dark-mode switch) above the keyless
  chain, custom endpoints (BYOK) and the web-search layer. Reachable from
  the sidebar (open and collapsed), the mobile menu, the ⌘K palette, and
  the composer's settings popover (`digdeep:open-settings` event).

## v2.0.1 — sidebar, lockup & quiet scrollbars (2026-10-10)

- **Tight brand lockup.** The ring mark and "DigDeep" wordmark now sit 6px
  apart (was 10) as one unit — new `LogoLockup` used by the sidebar header,
  the mobile top bar and the nav sheet, so the pair is identical everywhere.
- **Sidebar on one grid.** Recents rows were flush against the sidebar's left
  edge (status dot at x=0) while group labels sat at 16px and nav icons at
  24px — three competing axes. Now everything shares one grid: pills at
  12px margins, icons/dots/headings on the 24px axis. Added a hairline
  divider above Recents (symmetric with the footer), and the delete button
  sits inside the row's rounded pill.
- **Collapsed rail.** The 64px rail now anchors on the animated ring logo
  (click to expand) followed by uniform 40px ghost tiles — no more chunky
  solid pill next to bare icons.
- **Hidden scrollbars everywhere.** `slim-scroll` (a visible 5px bar in
  Chrome, a full default bar in Firefox) is gone: every scrollable surface —
  main, sidebar, dialogs, sheets, code blocks — scrolls without painting a
  bar. Wheel, trackpad, touch and keyboard scrolling are untouched.
- **Fixed a null-safety type error** in the recents delete-with-undo capture
  path (pre-existing since v2.0, surfaced by `tsc --noEmit`).

## v2.0 — the claim-verification upgrade (2026-10-10)

Four phases, four commits, each independently reviewable. The product promise
is unchanged: **free, no API keys, every claim cited — and never simulated
output presented as real.**

### Phase 1 — fix what was broken (`d786c81`)
- **Shareable reports.** `/r/<uuid>` links used to work only in the browser
  that created them. Any finished report can now save a read-only snapshot
  (keyless, in the same Postgres the engine already uses) and share
  `/r/s-<id>` — opens for anyone, in any browser, sources and claim evidence
  included. Viewers see a clear **"shared, read-only"** state; follow-ups
  start a new thread instead of mutating the snapshot.
- **Honest screen states everywhere**: loading skeletons (thread, library),
  designed empty states, errors with a recovery action, offline detection,
  and a distinct "report not found" vs "can't reach the server".
- **Versioned storage**: IndexedDB `digdeep` v1 → v2 with an in-place
  migration (verified against a seeded v1 database — nothing lost, thread
  metadata intact); zustand settings persist v2 + migrate.

### Phase 2 — claim-level verification, the main idea (`feb8a33`)
- Every claim in a report links to the source passage it rests on, with a
  verdict: **Verified** / **Partly supported** / **Unverified** — shown as
  icon + label + underline pattern (solid / dashed / wavy) so colour is never
  the only signal.
- **Evidence panel** beside the report (right rail on wide screens, bottom
  sheet on phones — closing returns focus to the claim). Shows the passage,
  the source, closeness to the original (primary / peer-reviewed / secondary /
  community — preprints are deliberately *not* "peer"), where to look, and
  the honest support ratio.
- Panel actions: copy citation, **re-check** (the same deterministic algorithm
  the engine ran — labeled as such, never a fake model call), go deeper,
  copy report with a claim-verification appendix.
- **J / K** claim navigation (works keyboard-only from cold), Esc closes.
- **Verdict bar** on every report ("3 of 5 sources fully support their
  claims") with patterned segments, and the same summary in Library rows.
- Engine: a claim-check ledger is built from the final drafts (after judge
  repairs), renumbered to the report's final citations, capped at 160 —
  **zero additional LLM calls**.

### Phase 3 — look and motion (`9c5b93f`)
- **New logo**: nested contour rings of the "D" — the outer outline fixed,
  eight inner rings streaming inward forever (fade in at the edge, fade out
  at the core, organic wobble, turning teal as they approach it). Idle the
  dig is slow (~9s a cycle); while research runs it speeds up (~2.8s).
  It is a live SVG — a few hundred bytes, replacing the 365KB animated WebP
  (the thing that made the header slow to arrive). Aligned to the wordmark
  at 0.00px deviation; fully static under `prefers-reduced-motion`.
  The favicon mirrors the same geometry (canvas-drawn, no image loads).
- **Palette**: verification teal is the accent; amber for partly supported,
  coral for unverified. **Fonts**: Bricolage Grotesque (headings), Geist
  (text), Geist Mono (citations) — self-hosted, keyless, offline builds.
- **Floating window**: ≥1180px the app is a rounded panel (max ~1280×840) on
  a darker backdrop; smaller screens fill the viewport edge to edge.
- **Compact**: ~16% tighter rhythm, ~8% smaller reading text. The sidebar
  hides its scrollbar. No size toggle — one considered size.

### Phase 4 — A-grade polish (`8868744`)
- **Accessibility**: all 16 palette pairs measured WCAG AA (both modes);
  global visible focus; 44px touch targets on coarse pointers; aria-live for
  progress and evidence; labelled landmarks; `prefers-reduced-transparency`
  and `prefers-contrast` handled.
- **Keyboard**: `N` new research, `/` focus the question box, `⌘/Ctrl+K`
  palette, `Esc` closes panels, `J/K` walk claims. Hints under the composer
  (pointer-fine devices).
- **Sidebar**: recents grouped by time, active row highlighted, delete with
  **undo** (turns are captured before deletion and re-saved on undo).
- **While researching**: honest engine-reported progress bar
  (`role=progressbar`), stop, retry, skeletons; the tab title follows the
  open question.
- **Writing**: sentence case, plain verbs; every error says what happened
  and how to fix it.

### Not changed (by design)
The search layer, the keyless LLM chain, the engine pipeline shape, the
per-browser IndexedDB ownership model, and the free/keyless promise.

### Known limitations (honest ones)
- Claim verdicts are deterministic lexical-support computations (plus the
  existing model judge for weak anchors) — the re-check button reruns the
  same rule; it is not a fresh model judgement and says so.
- Favicon drift while working is 2 fps — subtle by design; fully static under
  reduced motion.
- Shared snapshots freeze the report at share time; re-runs don't update them.
