# Changelog

## v3.11.0 — web access in chat: grounded replies with live citations (2026-10-30)

- **Chat can now answer current questions.** The chat lane used to be
  web-blind: ask "btw what's bitcoin at right now?" mid-conversation and the
  reply was "I cannot see the live web" (or, before v3.10, an improvised
  guess). Now the lane detects live-fact asks and runs ONE bounded web pass —
  search + up to 3 page reads — then writes the reply from those sources with
  inline [n] citations: conversational in shape, cited in substance. Pure
  small talk stays pure (no web pass, no cost); self-knowledge questions
  still answer from the product spec (the harness never searches the web for
  DigDeep itself).
- **Trigger:** `needsLiveFacts()` (intent-heuristics, zero-LLM, works when
  every model is throttled) fires on explicit search asks ("look it up",
  "google it"), freshness markers ("right now", "latest", "today's …"),
  volatile facts (prices, rates, weather, scores, release dates), year-
  qualified comparisons ("best laptops 2026"), recent-event shapes ("who
  won", "any news on") and state checks ("is twitter still called x") — and
  never on greetings, self-topics or timeless chat ("how are you today"
  stays offline). 22 pinned cases in test-routing.
- **Search quality:** mixed conversational messages are searched via
  `chatSearchQuery()` — a cleaner that strips the wrappers ("btw", "hey …",
  trailing politeness) which poison ranking (live-observed: the verbatim
  "btw …weather…right now" surfaced SPACE-weather pages; the cleaned query
  fixed it). The gate scores against the cleaned query but keeps the full
  message as intent reference.
- **Serverless survival (the quick-lane pattern, applied to chat):** the web
  pass checkpoints (`EngineCheckpoint.chat`, phase "drafting") and on the CF
  free plan YIELDS before the reply compose — a mid-compose CPU-cap death
  resumes at the reply with sources kept, no re-search, no duplicate section
  row. A throttle-death mid-web-pass still restarts the pass (searches are
  idempotent). Resume dispatch lives in runJob next to the quick lane's.
- **Assembly:** the reply gets the quick lane's citation treatment — [n]s
  remapped to source-row order, a References block appended to reportMd for
  export/share/copy, `sourcesConsulted` in stats, and the done line reads
  "Conversational answer in Ns · K live sources checked". The UI chat bubble
  renders the reply (References block stripped) with the sources prop wired
  so [n] chips link to the sources; throttled fallback now says the found
  sources are saved and offers regeneration.
- **Prompt:** CHAT_SYS's `knowledge_cutoff_and_live_information` and
  `the_chat_lane` sections rewritten for the source-pack mechanism — when a
  pack is present every factual claim must carry its [n] ("a grounded reply
  with zero [n] citations is a failed reply"), when absent the no-web rules
  apply. New `groundedChatPrompt()` keeps the chat voice (no headers, no
  References list in-text) while demanding citations. SELF_KNOWLEDGE's lane
  description updated to match.
- **Proof, not vibes:** `scripts/cf/run-chat-web-test.sh` — real engine, real
  web search, real LLM lanes, throwaway SQLite DB, CF profile — 23/23: pure
  chat runs no web pass; the live-facts message searches/reads (Source rows
  created), persists the checkpoint, yields at "Writing the reply…" 80%;
  runJob adoption resumes with sources unchanged, no duplicate section,
  completes with inline citations + References + sourcesConsulted; sliceN
  climbs. Honesty verified en route: when the retrieved sources genuinely
  didn't answer (the space-weather and IPL-cricket fixtures), the model said
  so plainly instead of papering over it — that's the designed gap behavior.
- Battery: tsc clean · eslint clean · 9 unit suites green (routing 48+22
  needsLiveFacts, jury, pin, relevance, court-render 48+12, compute 40, auth
  41, sysprompt 43) + the 23-check E2E. Note: whole-web engines (DDG et al)
  were IP-blocked from the dev sandbox during testing — the verticals
  (Bing News et al) carried the proof; on the live worker the whole-web
  engines are the ones that served Task 49's runs. Deploys with the pending
  Cloudflare redeploy.

## v3.10.0 — self-aware system prompt, Fable-5 structure (2026-10-30)

- **The chat model now knows who it is.** The models serving DigDeep's lanes
  are interchangeable rented backends (GLM, Mistral, MiniMax, DeepSeek…), and
  they arrive carrying their own identities — so a plain chat turn could be
  answered "as Mistral", with a claim of being ChatGPT, or with policies that
  are not DigDeep's. `CHAT_SYS` was one dense paragraph with no identity
  grounding; the product spec was only injected when a self-topic was
  detected, so every other reply ran identity-free.
- **CHAT_SYS rebuilt with the structure of the leaked Claude Fable 5 system
  prompt** (the ~120K-character Anthropic prompt): opener → `# digdeep_behavior`
  → `## product_information` (the grounded spec, now embedded on EVERY chat
  reply) → `## identity_and_the_harness` (self-awareness: the harness IS
  DigDeep, the backend is an implementation detail — "a car does not introduce
  itself by its engine"; never identify as the base model or claim to be
  ChatGPT/Claude/Gemini/Grok/Copilot; honest scripted answer for "which model
  are you?"; knows about the throttled built-in-script fallback and that the
  interface labels the serving backend) → `## tone_and_formatting` with
  `### lists_and_bullets` → `## responding_to_mistakes_and_criticism` →
  `## knowledge_cutoff_and_live_information` (no browsing in chat, never
  fabricate, hand time-sensitive questions to the research lanes) →
  `## evenhandedness` (court mode exists for verdicts) → `## user_wellbeing`
  → `## the_chat_lane` (the harness spec, where Fable has its memory
  filesystem: what the lane sees, what it must never do).
- **Self-identity leaks fixed across all lanes:** the chat and quick-answer
  prompts said "in a Claude-like voice" — telling rented models to imitate a
  rival assistant, which is exactly how identity confusion starts. Both now
  say "in DigDeep's voice / You ARE DigDeep — never claim to be any other
  assistant or its maker". `RESEARCHER_SYS` gains the harness identity line.
  The grounded spec now answers "who made you" honestly: DigDeep is an
  independent project, not affiliated with any AI lab.
- **Proof, not vibes:** live probe (`scripts/probe-self-identity.ts`) sends
  the real `CHAT_SYS` to a real keyless backend and asks the three
  identity-breaking questions — 3/3 clean: "I'm DigDeep… I'm not ChatGPT";
  "an independent project… not affiliated with OpenAI, Anthropic"; honest
  about no browsing in chat + offers a research run. New structural suite
  `scripts/test-sysprompt.ts` (33 checks) pins the Fable skeleton order, the
  always-embedded product spec, every identity rule, catalog-label
  consistency (the backends named in the prompt must exist in
  `model-choices.ts`), the surviving craft rules, size bounds (4–12 KB —
  fits 32k-context backends; actual 8.6 KB), and no residual "Claude-like".
- Battery: tsc clean · eslint clean · 9 unit suites green (routing 48,
  jury, pin, relevance, court-render 48+12, compute 40, auth 41,
  sysprompt 33). Note: the deployed Cloudflare worker still runs v3.9.0 —
  this ships with the pending redeploy (needs the Cloudflare token).

## v3.9.1 — quick answers survive hosts that kill long slices (2026-10-27)

- **Found live on the Cloudflare free deployment.** A quick-answer run died at
  the "Writing the answer" step — twice, at the same point — because the whole
  run (search → read → streamed compose) executed inside ONE request event, and
  the free plan's per-event CPU cap killed the isolate mid-compose. Worse: the
  quick lane never checkpointed, so every re-trigger restarted the whole run
  from 0% — re-searching, re-reading, re-composing, forever (observed live:
  9 orphan "Quick answer" sections, the same 3 sources re-read each cycle, and
  `sliceN` never climbed because it was only persisted on checkpoint-resumes,
  so the runaway guard never fired).
- The engine now slices on Cloudflare exactly as it has on Vercel since v2.5.0:
  `CF_PROFILE=1` activates the slice clock (45s default, `DIGDEEP_SLICE_MS`
  to tune), checkpoints, and yields. The quick lane checkpoints its
  search+read pass and hands the streamed compose a fresh slice of its own —
  the heaviest call gets a fresh per-event CPU budget.
- A resumed quick run first tries to **salvage the partial draft** the dead
  attempt streamed into its section row (flushed every ~1.1s): if most of the
  answer is already written, the run completes from it, honestly labeled —
  no re-compose gamble.
- Anti-livelock guard: `sliceN` is persisted on EVERY adoption (60-slice cap
  on CF), so a platform that keeps killing slices mid-phase now fails the run
  honestly ("start a fresh run") instead of looping forever.
- Audit tooling: `scripts/cf/worker-audit.sh` — the full live battery
  (55 checks) retargeted from `digdeepx.vercel.app` to the Cloudflare worker,
  with v3.9.0 semantics (the secret-guarded `/api/admin/migrate` schema
  snapshot, D1 column-count verification, the CF SVG og variants) and a
  single controlled OTP-lane probe. Note for fixtures: Supabase rejects
  reserved email domains (`example.com`) with `email_address_invalid` — the
  app maps that upstream rejection to the honest 502 "temporarily
  unavailable" (the v3.5.2 fix working as designed).
- API version string caught up: `3.7.0` → `3.9.1` (it had missed the 3.8/3.9
  hosting migrations).

## v3.9.0 — the database is D1, everywhere (2026-10-27)

- **SQLite everywhere, platform-adaptive adapter.** One generated client
  (SQLite dialect, query-compiler WASM — no native engine binary), two runtime
  adapters: Cloudflare D1 (the `DB` binding, via `@prisma/adapter-d1`) in
  production, better-sqlite3 locally (FK enforcement ON so cascade deletes
  behave exactly like D1). A stale `postgres://` `DATABASE_URL` now fails
  loudly with migration guidance instead of constructing a broken client.
- `DATABASE_URL` is gone from the worker entirely — the app's only database is
  the D1 database `digdeep-db` (schema: `scripts/cf/d1-init.sql`, idempotent —
  15 tables, 20 indexes, FK constraints; D1 enforces FKs by default).
  Supabase stays as a service for OTP email only.
- The old Postgres-era `/api/admin/migrate` additive-repair endpoint became a
  **D1 schema snapshot tool**: GET (secret-guarded) reports every table's
  shape via `PRAGMA table_info`; POST is a safe no-op that reports the current
  shape and the correct runbook — old runbooks fail closed instead of
  corrupting D1 with Postgres DDL.

## v3.8.0 — hosted on Cloudflare, 100% free (2026-10-22)

- **DigDeep runs on the Cloudflare Workers free plan.** Prisma driver adapters
  (no native engine binary), `AUTH_SCRYPT_N` profile-tunable (16384 on CF —
  the empirical CPU ceiling of the free plan; 32768 on Vercel/local; stored
  hashes carry their own parameters so accounts verify cross-platform), and a
  CF build profile that swaps `next/og`'s satori/resvg wasm for the SVG card
  variant — the bundle lands at 2368 KiB gzipped against the 3 MiB free-plan
  limit (704 KiB headroom, zero wasm).
- Live at `digdeep.mahmoudmohamedxx1.workers.dev`. The Vercel path stays
  fully intact and green on the same commit.

## v3.6.0 — chatting now needs an account (2026-10-21)

- **The operator closed anonymous chatting.** Anyone who wants to talk to
  DigDeep — home composer, follow-ups, related-question taps — signs in first.
  One email code, no password; the account page takes you straight back to
  what you were writing (`?next=` round-trip).
- The gate is server-side and total on the chat entry point: `POST /api/research`
  answers `401 {"code":"auth_required"}` without a session. Deliberately
  unchanged: reading old anonymous threads (capability URLs), share pages
  (public-by-choice), exports of shared/anonymous runs, and every v1 + MCP
  start (those were never anonymous — Bearer key + `research:write` scope).
- The UI says so before you type: a quiet "Chatting needs a free account —
  sign in with an email code" strip under the home composer and above the
  follow-up box on threads; submitting while signed out routes to `/account`
  and bounces you back after sign-in (relative-path validated — no open
  redirect).
- Home hero microcopy: "Free & keyless" → "Free · no LLM keys needed" (the
  keyless LLM chain is still the truth; "keyless" alone now reads ambiguous
  next to a sign-in gate).
- `scripts/replay-self-questions.sh` signs in a local dev account first.
- Permanent tests: standalone 5b (anon 401 + auth_required body + validation
  order + signed-in start) and prod-audit E2 (same, live, plus immediate
  cancel of the probe run for cost hygiene) — 108 → 113 standalone checks,
  35 → 38 live checks.

## v3.5.2 — a rejected send is not your email's fault (2026-10-21)

- **Found live during the deep audit.** When Supabase rejects an OTP *send* for
  an operational reason (email-cap edge responses, signup toggle, domain
  allowlist, provider policy), the API answered `400 "Enter a valid email
  address."` — blaming an address that had already passed our own validation.
  Real users would retry the same valid email and keep getting told it was
  invalid. Upstream send rejections now answer `502 "Email codes are
  temporarily unavailable — try again shortly."` — an honest, non-enumerating
  outage signal. Our own regex validation still returns the 400 (that message
  is only shown when the address really is malformed).
- Locked with a permanent standalone check: a mock-Supabase policy rejection
  (`@reject.test` fixture → upstream 400 `signup_disabled`) must surface as
  502 + temporary-unavailable, never as "Enter a valid email address."
- API version strings (`/api/openapi.json`, MCP server info) bumped from the
  stale 3.4.0 to 3.5.2.
- New ops forensics: `scripts/audit-cap-watch.sh` (watches the Supabase
  built-in mailer's 2/hour project cap and captures the raw upstream verdict
  when a slot frees) and `scripts/audit-prod-fingerprint.sh` (OTP behavior
  fingerprint + budget-free real-code verify through any deployment).

## v2.9.0 — chatting with the gavel up stays chatting (2026-10-19)

- **"Chatting while court is activated is really bad."** Root cause: with Court
  mode on, the router sent EVERY message that wasn't a greeting to a full trial —
  "what is 2+2", "tell me a joke", "who is Elon Musk" all launched prosecutor +
  defense + jury + judge. The gavel now respects what a message actually is:
  - **Claims go to trial, instantly.** Clear claim/debate shapes — "is X better
    than Y", "X vs Y", "is it true that…", "should X be banned", "do you think…",
    "X is overhyped", first-person opinions, hearsay ("my friend says…") — skip
    the classifier and go straight to court (zero added latency).
  - **Everything else gets the normal lanes.** Simple lookups, info requests,
    how-to's, jokes, translations and open-ended topics run through the same
    understanding-first router as court-off messages — now court-aware: it can
    still send a genuine proposition to trial on its own read, and says so when
    it doesn't ("Court mode is on, but this is conversation, not a claim — the
    gavel stays down for it"). Verified live: joke → 2s chat; "what is 2+2" →
    17s quick answer with 3 cited sources.
  - **A concluded case is never re-tried.** "What is the court opinion",
    "what did the jury say", "why did the judge rule guilty" used to launch a
    brand-new trial of the thread's topic; now they recall the actual verdict
    from the thread's court record (charge, jury split, every juror's vote and
    reason, the judge's summary, charges that stuck, conditions) — answered in
    chat mode in ~3s, from the record, never invented. Real-world courts
    ("supreme court opinion on abortion", "trial of Socrates") never trigger
    the recall.
  - **Throttle-safe.** If the router model is unavailable and the gavel is up,
    an ambiguous question still gets its trial; a clearly-not-a-claim message
    still researches normally — and the in-memory court flag is dropped for
    no-trial runs so the plan, the debate stage and the report all treat it as
    ordinary research.

## v2.8.1 — a pinned model stays your model (2026-10-19)

- **"I picked MiniMax-M2.7, but OpenAI answered."** Not a bug — the designed
  failover: the pin's lane rides a *shared anonymous* LLM7 quota that throttles
  in waves, and when it was cooling at the moment of a simple question, the
  fast chat/quick lanes skipped it silently and the next healthy lane answered
  (Pollinations serves an OpenAI model — the app then honestly attributed the
  reply to "openai"). Deep research was already patient and rode out cooldowns
  until the pin served; quick replies weren't. Two fixes:
- **Sticky pin.** A pinned lane in a *short* cooldown now gets a bounded
  head-start wait before the pool is allowed to answer — scaled to the step's
  own patience budget (a chat reply waits up to ~10s, a quick answer ~20s,
  deep-research steps up to 90s). Long quota rests still fall through instantly
  (never parks a "hi" for minutes), tiny routing calls never wait, and a pinned
  lane that fails on a momentary blip gets one soft retry (12s per attempt) in
  substantive fast calls — quota and hard-access errors still skip immediately.
- **Substitutions are announced.** When someone other than your pin answers a
  chat or quick reply, the feed now says it outright — "MiniMax-M2.7 is
  rate-limited — answered by Pollinations (openai) instead" — plus why (free
  lane resting), that the next healthy lane answered rather than making you
  wait, and that the pin resumes automatically on the next message. The done
  line carries the same note, and `LlmResult.backendLabel` gives the UI the
  serving lane's human name. Verified E2E on a live throttled window: a
  "hi there!" with MiniMax pinned completed in 36s with the notice in the feed
  and `byModel: openai` honestly attributed.
- Tests: 52 pin assertions (12 new sticky-pin + lane-resolution cases) —
  all pass; routing suite unaffected; tsc + `next build --webpack` clean.

## v2.6.0 — the chat stops fighting you + you pick the model route (2026-10-19)

- **Scrolling up no longer gets yanked back down.** The old follow logic used
  distance hysteresis: scrolling up less than 160px still counted as "at the
  bottom", so while anything streamed, the DOM observer kept snapping the
  reader to the bottom mid-scroll — the page fought you. Follow is now pure
  intent: ANY upward movement (>3px, real intent, not sub-pixel jitter)
  releases the pin instantly; touching the bottom re-pins. Verified in-browser
  against a live run with injected 2× content growth: position held at
  exactly 400px through 1750→3610px of growth, zero yank events.
- **The jump-to-latest button is a real affordance now.** It was a lone 40px
  circle fixed to the viewport center — which on xl screens isn't even the
  chat column's center (the evidence rail shifts it left). Now a labeled glass
  pill ("Live · jump to latest" while a run streams, pulsing dot included)
  hangs exactly above the composer, centered on the chat column at every
  breakpoint, with show/hide hysteresis (appears ≥140px away, hides ≤90px) so
  it never flickers at the threshold. Click = smooth flight to the bottom
  (bounded 900ms so a moving target can't strand it) and following resumes.
- **Choose the main model.** The composer's Research settings now offer four
  routes: **GLM main · LLM7 helps** (the default), **LLM7 main · GLM helps**
  (new — the mirror route: the keyless multi-model pool leads every step,
  z.ai GLM rides behind as failover), plus the two single-family pins. The
  choice flows end-to-end: store → POST body → `job.modelPref` → the engine's
  backend ordering (`orderedBackends`) → the run's first activity line
  ("route: LLM7 multi-model keyless pool leads → Pollinations → z.ai GLM
  failover"). Verified live: a run started with the new route persisted
  `modelPref: llm7` and printed the mirror-route line.
- **The chat window is 75%, not 100%.** Wherever the chat column would run
  edge-to-edge (phones, small tablets — every viewport below ~1024px), it now
  caps at `min(768px, 75%)` — a centered reading column instead of a full-bleed
  one. Home hero, composer, suggestions, thread turns, shared banner, loading
  skeleton and the bottom dock all share the same cap so everything stays
  aligned. Desktop (≥1024px) is unchanged: the 768px cap already held it well
  under 75%. Measured: 600px viewport → 71% column, 375px → 75% dock, zero
  horizontal overflow.
- **Scrolling is smoother while a run streams.** Every poller tick (1.2s) and
  every per-second clock tick re-rendered *every* turn in the thread — the
  jank you felt while scrolling a busy thread. `ThreadTurn` is memoized now:
  finished turns keep their object identity and skip re-rendering entirely;
  only the live turn re-renders (its elapsed/timestamps must tick).

## v2.0.5 — one brand color everywhere + a light mode that actually toggles (2026-10-10)

- **The animated logo now wears the brand color.** It was silver/periwinkle
  artwork with ~38% of its painted pixels at mid alpha — translucent on both
  canvases. Rebuilt as an alpha MASK (`scripts/teal_brand.py`): the same
  64-frame animation, its geometry re-crisped (smoothstep 72→144 kills the
  mid-alpha smear), painted `var(--primary)` — so the mark is pixel-identical
  to the "Deep" half of the wordmark in both themes (light `#0f766e`, dark
  `#2dd4bf`) and reads SOLID. Verified: mask animates in Chromium (three
  sampled frames differ), 20% solid-teal coverage at 24px vs the old
  semi-transparent smear.
- **The animated background speaks the same color.** The home hero aurora was
  violet/blue/purple — a different family from the brand. All three blobs now
  derive from `var(--primary)` (26/18/22% light, 34/26/30% dark) — the "Deep"
  teal, whisper-subtle as before.
- **Light mode is fixed — it never actually toggled for system-dark users.**
  The Dark-mode switch was bound to next-themes' `theme` (the *preference*,
  `"system"`), not the applied mode — so on a dark-OS machine the switch read
  OFF while the app was visibly dark, and flipping it seemed to do nothing.
  `resolvedTheme` (v0.4.6) lags the DOM in the system state, so the shell now
  derives ground truth from the `<html>` class via MutationObserver
  (`useResolvedTheme`) — the switch always mirrors what the user actually
  sees, and the ⌘K palette item flips the real mode too. Verified end-to-end:
  system-dark → switch ON → toggle OFF → paper canvas `#f7f7f5` → persists
  across reload → toggle ON → charcoal again.
- **No more sideways home page.** On touch, a left-swipe panned the whole
  home page sideways: the AuroraHero bleeds ±240px past the column, and with
  `overflow-visible` that bleed widened the document to ~855px on a 375px
  screen. The page root is now `overflow-x-clip` — measured at 375px:
  `scrollWidth === clientWidth === 375`, `scrollTo(30,0)` leaves `scrollX` at
  0. Glows and vertical behavior untouched.
- **Favicon, toast badge and idle tab icon join the family** — teal emblem
  on the dark badge (`mark-favicon.png`, `mark-badge.png`, `icon.png`),
  same geometry as the dynamic status favicon, so idle/working/done read as
  one icon.
- Ops note: `next-server` renames its process, so `pkill -f
  ".next/standalone/server.js"` never matched — restarts silently failed with
  EADDRINUSE while a stale build kept serving. Restart procedure now kills by
  PID from `ss -ltnp` and verifies the served chunk hash.

## v2.0.4 — solid emblem (no more semi-transparency) + chat flow that follows you (2026-10-10)

- **The animated emblem is finally SOLID.** The shipped animation turned out
  to be genuinely semi-transparent: it was encoded with premultiplied colors
  that browsers composite as straight alpha — double-multiplied to ~25%
  brightness, with not a single fully-opaque pixel in the file (max alpha
  127). Rebuilt from the clean source frames: straight colors + an alpha
  saturation curve + 2px line dilation, so the contour lines that the artist
  drew as solid strokes read solid at the 28px sidebar size too (measured:
  broken max luminance 43 on dark, now 150; the original GIF itself only
  reaches 79 at that size). 64 frames, 8s loop, 372KB — smaller than before.
- **Light mode gets the ink treatment.** The emblem's silver lines are
  white-on-white on light surfaces (measured contrast: 1/255). Light mode
  now tone-shifts the same geometry and animation to graphite-and-purple
  (`brightness(0.6) saturate(1.25)`) — visible on white, unchanged in dark.
- **The page now follows the typing.** Content growth doesn't fire scroll
  events, so the streaming answer could pour text past the fold with no
  auto-follow and no jump button — and the completed-view swap (+212px in
  one mutation batch) jumped clean past the old distance check, leaving the
  newest reply hidden behind the composer. Follow state is now the reader's
  *intent*: scrolling up unfollows (jump button appears), reaching the
  bottom re-pins. Verified live on real engine runs — the view stays glued
  to the newest line through submit → think → stream → type → complete.
- **Code blocks grew a header.** Language tag + a copy button (hover-reveal
  on desktop, always visible on touch) on every fenced code block.
- **"Turn this into a full research report"** — a quiet teal pill after
  every completed chat reply that hands the same question to the full
  research pipeline (multi-source, visible steps, cited report), in the
  same thread.
- **Copy that always reports honestly.** All copy affordances (question,
  reply/report, code, citation, appendix) share one helper with an
  execCommand fallback — and a failed copy never shows the confirmation
  check.
- **Follow-up drafts survive navigation.** Typed text in the thread
  composer is kept per-thread in sessionStorage and restored when you come
  back; submitting clears it.
- Favicon/notification badge rebuilt from the bolder mark (legible at
  16px tabs, max brightness 226).

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
