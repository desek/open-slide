# CR-0003 Validation Report

Validated 2026-07-29 against `feat/export-slides-as-video` @ `0a56551`
(source-commit `959a994`). Merge base with `origin/main`: `35dc46c`.

Re-traced 2026-07-29 after the gap-fix pass on top of `8dbcd3f`. Every `file:line`
reference below now points at the post-fix tree.

Pipeline: no `make` targets in this repository; ran the documented scripts.

| Command | Result |
|---|---|
| `pnpm test` | PASS — 26 files, 398 tests, 0 failures (`video.test.ts` 54, `run.test.ts` 14) |
| `pnpm typecheck` | PASS — 3 turbo tasks successful |
| `pnpm check` | PASS — exit 0; 1 biome warning in `packages/core/src/http/request-guard.ts`, a file untouched by this branch (last changed in `24b7311`, pre-merge-base) |
| `pnpm core build` | PASS — build complete, 21 files / 315.43 kB; 0 occurrences of `playwright` in `dist/index.js` |

## Summary

Requirements: 49/49 | Acceptance Criteria: 30/30 | Tests: 23/23 | Gaps: 0

FAIL: 0 | PARTIAL: 0 | GAP: 0

All six gaps recorded in the first pass are closed. G1 was a real behavioural
defect, fixed with a regression spec confirmed to fail against the old code; G2 is
fixed by single-sourcing the constant; G3, G4, G5 and G6 were evidence shortfalls,
and the missing measurements have now been taken and recorded in the rows above. A
seventh entry, G7, promotes the latent silent-failure the first pass filed only as
an observation, and closes it defensively rather than documenting it as an accepted
invariant.

One residual limit is stated rather than papered over, under G4: AC-8 clause 2 is
verified at both endpoints and by construction in between, not against an
independent viewer reference, because no second renderer exists to compare with.
Closing it fully would need a CR amendment, which is out of a gap-fix pass's remit.

## Requirement Verification

### Functional Requirements

| Req # | Description | Status | Evidence (file:line / test name) |
|---|---|---|---|
| FR-1 | `video` subcommand renders pages to MP4 via headless Chromium | PASS | `run.ts:226-292`; `video.ts:1096-1223` |
| FR-2 | `--slide` / `--all`, mutually exclusive | PASS | `video.ts:1076-1078`; test `validateFlags rejects --slide with --all` |
| FR-3 | `--page <n>` requires `--slide` | PASS | `video.ts:1079-1081`; test `validateFlags rejects --page without --slide` |
| FR-4 | Default is exactly one MP4 in page order | PASS | `video.ts:915-951`, `992-996`; phase-2 checkpoint `198e40c`: `slide-transitions` captured as one file across six advances |
| FR-5 | `--per-page` writes `{slideId}-p{NN}.mp4` | PASS | `run.ts:236`; `video.ts:963-983`, `646-653`; test `videoFilenameFor derives a page-level name for the per-page shape` |
| FR-6 | `--fps <n>`, rejects outside 1–120 | PASS | `run.ts:238`; `video.ts:1085-1087`; tests `validateFlags rejects an out-of-range fps` and `an out-of-range --fps exits 2 through the video subcommand` |
| FR-7 | `--dwell <ms>`, run-wide, default 1500 | PASS | `run.ts:246-250`; `video.ts:94`, `1137`, `449`; test `defaults dwell to 1500ms` |
| FR-8 | Transitions captured from the viewer, never synthesised | PASS | `video.ts:803-824`, `748-750`; no `-filter_complex` at `video.ts:1026-1067` |
| FR-9 | Honour whatever transition the viewer resolves | PASS | `video.ts:251-275` reads live animations off the DOM; `video.ts` imports nothing from `app/lib/transition.ts` |
| FR-10 | One continuous browsing session | PASS | `video.ts:925` is the only `goto` in `captureWholeDeck`; the page loop `929-943` never reloads |
| FR-11 | Advance through the viewer, never by `?p=` reload | PASS | `video.ts:812` `page.keyboard.press('ArrowRight')` |
| FR-12 | Boundary measured, not read off `SlideTransition.duration` | PASS | `video.ts:251-275`; phase-3 checkpoint `e6ee19a`: `slide-transitions` measured 280/280/540/320/280 ms and `morph-demo` 1250 ms, none equal to the declared value |
| FR-13 | Boundary animations finished after capture | PASS | `video.ts:822` `waitForFunction(settleTransition)`; `video.ts:376-405`; phase-3 `e6ee19a`: `morph-demo` final page clean after three morph boundaries. Hardened under G7: the settled tag is now applied before `finish()`, so a throwing `finish()` cannot leave a boundary tag for the next page to measure; spec `settleTransition tagging retags a boundary animation whose finish throws` |
| FR-14 | Context emulates `reducedMotion: 'no-preference'` | PASS | `video.ts:1166` — read directly, not inferred from a test name |
| FR-15 | Page duration from the longest finite animation | PASS | `video.ts:211-227`; test `resolveDurationMs uses the measured value` |
| FR-16 | All-infinite / no-animation page contributes dwell | PASS | `video.ts:426`; tests `resolveDurationMs falls back when nothing is measurable`, `planDeckTimeline applies one dwell to every page` |
| FR-17 | Infinite animations seeked along with finite ones | PASS | `video.ts:220` excludes them from measurement only; `video.ts:295-303` seeks every non-settled animation. Behavioural, not by reading: tests `infinite animations are paused and counted but left out of the duration measurement` and `are seeked with everything else, so a looping page still animates` run the browser-side helpers against a stubbed animation set. Capture evidence under AC-6 |
| FR-18 | Clamp to documented 60000 ms | PASS | `video.ts:91`, `425-427`, `473`; tests `resolveDurationMs clamps a runaway duration`, `planDeckTimeline clamps a runaway boundary` |
| FR-19 | `--duration <ms>` replaces measured duration | PASS | `run.ts:240-245`; `video.ts:425`; test `replaces every page duration with the override but leaves boundaries measured` |
| FR-20 | Every animation paused, never finishes (except FR-13) | PASS | `video.ts:325-334` init script sweeps from document start on a 4 ms interval; `video.ts:726` re-pauses per page |
| FR-21 | MUST NOT gate on `window.__OPEN_SLIDE_EXPORT_READY` | PASS | Verified by reading, not by test name: the string does not occur anywhere in `video.ts`; the only readiness wait is `video.ts:703-711`, `document.fonts.status === 'loaded'` |
| FR-22 | Wait for fonts before any frame | PASS | `video.ts:926` (whole-deck), `video.ts:971` (per-page) |
| FR-23 | Frames at exactly 1920×1080 | PASS | `video.ts:1164` viewport + `deviceScaleFactor: 1`; `video.ts:751-754` clip; phase-4 `fb36586` ffprobe 1920x1080 |
| FR-24 | Determinism split by segment kind | PASS | Phase-4 `fb36586` measured: `vercel-ai-sdk` byte-identical; `morph-demo` 1/654 frames at YMAX 1; `slide-transitions` 10/860 at YMAX 93 / YAVG 0.16, all inside boundary segments. Determinism mechanism at `video.ts:328` (`playState` guard) and `video.ts:304-306` (two-rAF paint wait) |
| FR-25 | Preflight `playwright-chromium`, exit 2 | PASS | `video.ts:1107-1119` |
| FR-26 | Preflight `ffmpeg`, exit 2 | PASS | `video.ts:1005-1011`, `1121-1133` — before `startDevServer` at `1145` |
| FR-27 | Zero-page decks named on stderr and skipped | PASS | `video.ts:1150-1154` reusing `zeroPageDeckIds` from `export.ts` |
| FR-28 | H.264 / yuv420p / even dimensions | PASS | `video.ts:1037-1045`; phase-4 `fb36586` ffprobe `h264`, `yuv420p`, `1920x1080`, `30/1` on both shapes |
| FR-29 | Frames removed unless `--keep-frames` | PASS | `video.ts:1197`; phase-4 `fb36586`: `build-on-reveal` left no frame directory |
| FR-30 | Tear down browser and dev server on every exit path | PASS | `video.ts:1214`, `1218`, `1221` (`closeAll` in both catch branches and `finally`) |
| FR-31 | Usage/preflight exit 2; runtime exit 1 | PASS | Correct inside `videoCommand` (`video.ts:1101-1104`, `1118`, `1132`, `1215`, `1219`), and now correct on the argParser path too: `run.ts:26`, `111`, `121` throw `InvalidArgumentError`, and `run.ts:150-152` remaps every non-zero Commander exit to 2. Measured through the real binary — `--fps 0`, `--page 0`, `--duration 0`, `--dwell -1`, `--timeout 0`, `--port 99999` and an unknown subcommand all exit **2**; `--help`, `--version`, `video --help` exit **0**; the runtime path exits **1** (see AC-26) |
| FR-32 | `playwright-chromium` devDependency, dynamic import only | PASS | root `package.json` devDependencies and `packages/core/package.json:105` (neither in `dependencies`); `export.ts:61-67` dynamic import; `packages/core/dist/index.js` contains 0 occurrences of `playwright` |
| FR-33 | Report animations, duration, frame count per page | PASS | `video.ts:760-769`, `771-783`; phase-2 `198e40c` reported 5 animations / 18 frames for `vercel-ai-sdk` p1 |
| FR-34 | `--help` examples cover every flag | PASS | `run.ts:260-288` — 11 examples covering `--slide`, `--page`, `--all`, `--out`, `--fps`, `--dwell`, `--duration`, `--per-page`, `--keep-frames`, `--port`, `--timeout` |
| FR-35 | Detect and name step-gated pages from `[data-osd-step]` | PASS | `video.ts:345-347`, `840-854`; no new `window` hook added anywhere in the diff |
| FR-36 | Warning states pages → shape change + why → revealed-but-no-motion → loop variant | PASS | `video.ts:618-630` in exactly that order; tests `stepGatedWarning names the pages, the shape change, and the loop variant`, `states the shape change before its consequences` |
| FR-37 | Warning does not fail the run | PASS | `video.ts:1179-1181` writes to stderr only; phase-4 `fb36586`: `build-on-reveal` exits 0 |
| FR-38 | Step-gated deck → per-page without `--per-page`; no viewer change | PASS | `video.ts:577-583`, `963-983`; `capturePerPage` never presses a key; `player.tsx` / `step-context.tsx` absent from the branch diff |
| FR-39 | Fallback and `--per-page` share capture, encode, filename | PASS | Single capture step `capturePage` `video.ts:890-906`; single shape branch `captureDeck` `video.ts:992-996`; single encode loop `video.ts:1195-1201`; single derivation `videoFilenameFor` `video.ts:646-653`. Phase-3 `e6ee19a`: `steps-in-motion` wrote 14 files named identically to a flagged run |
| FR-40 | Shape settled for every page before any frame | PASS | `probeStepCounts` `video.ts:840-854` called at `1173`, before `captureDeck` at `1183` |
| FR-41 | Mixed `--all` produces both shapes; summary states shape per deck | PASS | `video.ts:595-604`, `1203`, `1210`; tests `distinguishes a requested per-page run from a forced one`, `states the file count so a mixed run is legible` |

### Non-Functional Requirements

| Req # | Description | Status | Evidence |
|---|---|---|---|
| NFR-1 | Reuse export module helpers | PASS | `video.ts:40-49` imports `atomicWriteFile`, `ExportUsageError`, `enumerateSlides`, `resolveExportTargets`, `startDevServer`, `tryImportPlaywright`, `zeroPageDeckIds` |
| NFR-2 | Readiness predicates and timing constants live in one place | PASS | `DEFAULT_TIMEOUT_MS` is declared once, at `export.ts:41-49`, and imported by `video.ts:42`; `video.ts` no longer redeclares any constant `export.ts` owns. The two font predicates stay distinct — FR-21 forbids reaching the viewer-side one through the export readiness gate — and the divergence is now stated at `video.ts:695-701` instead of being left implicit. See G2 |
| NFR-3 | Transition behaviour single sourced in the viewer | PASS | `video.ts` imports nothing from `app/lib/transition.ts`; test `boundary identification is read from the transition wrapper and the morph overlay, not from a declared duration` |
| NFR-4 | Pure helpers exported separately; planner measures nothing | PASS | `video.ts:414-529` are pure and exported; `video.test.ts` exercises them with no Playwright or ffmpeg (50 tests, 15 ms) |
| NFR-5 | `pnpm check` and `pnpm typecheck` pass clean | PASS | both exit 0; the single biome warning is in `request-guard.ts`, outside the branch diff |
| NFR-6 | No authoring change to existing decks | PASS | No file under `apps/demo/slides/` other than the new `governance-loop` deck appears in the branch diff |
| NFR-7 | `.changeset/` entry, `minor`, `@open-slide/core` | PASS | `.changeset/wild-pumas-film.md` — `'@open-slide/core': minor`, single present-tense line. The gap-fix pass adds `.changeset/lazy-moons-shave.md` — `patch`, because the G1 fix also changes the existing `export` subcommand's malformed-flag exit code, which the `minor` entry does not describe |
| NFR-8 | Loop-variant elements single sourced, enforced by a spec reading the file off disk | PASS | Constant `video.ts:133-138`; warning composes from it at `video.ts:628`; spec `video.test.ts:294-308` `readFileSync`s `packages/core/skills/slide-authoring/references/loop-variant.md` and asserts all four elements case-insensitively. Verified the spec reads the real path and passes: the four elements appear at `loop-variant.md:9,10,11,12` |

## Acceptance Criteria Verification

| AC # | Description | Status | Evidence |
|---|---|---|---|
| AC-1 | Deck captures to a single file, pages in order | PASS | `video.ts:915-951`; phase-2 `198e40c`: `slide-transitions` one file across six advances |
| AC-2 | Animation captured mid-flight, not settled | PASS | Phase-2 `198e40c`: `vercel-ai-sdk` at 12fps produced 18 of 18 unique frames on page 1 |
| AC-3 | Readiness flag not used to gate capture | PASS | Inspection AC. No `__OPEN_SLIDE_EXPORT_READY` in `video.ts`; font wait at `video.ts:703-711` is independent of animation completion |
| AC-4 | Animations never reach a finished state; count > 0 | PASS | `video.ts:325-334`; phase-2 `198e40c`: 5 animations detected on `vercel-ai-sdk` p1 |
| AC-5 | Page with no finite animation still contributes | PASS | Tests `resolveDurationMs falls back when nothing is measurable`, `frameCountFor never returns zero`, `planDeckTimeline applies one dwell to every page` (third page `longestMs: 0`) |
| AC-6 | Looping animation animates in the output | PASS | Captured. `apps/demo/slides/vercel-ai-sdk/index.tsx:166` carries `vai-pulse 2.4s ease-in-out infinite` on page 1. Unforced, that page reports `5 animation(s), 1500ms` — the infinite one is counted and paused but contributes no duration, which is the exclusion half. Forced to `--duration 4000 --dwell 0 --fps 10 --keep-frames`, the 20 frames seeked past 1500 ms — past the end of every finite animation on the page — hold 13 distinct images: t=2000/2600/3200/3900 ms all differ pairwise, and so do the adjacent frames at t=3000/3100 ms. Nothing but the infinite pulse can move there. Contrast AC-7's dwell frames, byte-identical because the dwell clamps the seek |
| AC-7 | Dwell holds the settled state | PASS | Phase-3 `e6ee19a`: `vercel-ai-sdk` p1 at 8fps gave 12 distinct animation frames followed by 12 byte-identical dwell frames; `seekTimeMsFor` clamp at `video.ts:522-524` with tests `holds the settled state across the dwell frames` |
| AC-8 | Pages joined by the viewer's own transition | PASS | Clause 1: boundary frames come from `measureBoundary`/`seekTo(boundaryOnly)` (`video.ts:251-275`, `748-750`). Clause 3 measured: `vercel-ai-sdk` declares no transition, and its whole-deck capture reported `no transition declared` at all seven boundaries and wrote 64 frames — exactly 9+8+6+9+7+7+10+8, the sum of its page segments, so zero boundary frames. Clause 2 measured as far as it is measurable; see G4 |
| AC-9 | Transitions are not synthesised | PASS | Inspection AC. `video.ts` declares no durations, easings, or keyframes and imports no transition module; `encodeFrames` `video.ts:1026-1067` carries no filter graph and documents why |
| AC-10 | Page segments and dwell holds byte-identical across runs | PASS | Phase-4 `fb36586`, three runs of `slide-transitions` + three of `morph-demo` + two of `vercel-ai-sdk`: every observed cross-run difference sat inside a transition boundary segment; frame counts equal segment for segment |
| AC-10a | Boundary segments meet the perceptual bound | PASS | Bounds met and measured: `slide-transitions` 10/860 frames at YMAX 93 / YAVG 0.16; `morph-demo` 1/654 at YMAX 1 / YAVG 0.0003; `vercel-ai-sdk` byte-identical (phase-4 `fb36586`, ≥3 captures per deck as the Test Strategy requires). The third clause is now measured too — `slide-transitions` at 10fps with frames retained: the five boundary segments hold 3/3, 3/3, 4/5, 3/3 and 3/3 distinct images, against a control page segment of 33 frames that collapses to 1. No boundary frame equals the incoming settled frame; at most one per boundary equals the outgoing settled frame, and always its t=0 frame, which is what offset zero should render — `p4→p5` matches neither. See G5 |
| AC-11 | Missing prerequisites reported, not crashed into | PASS | Both halves run. ffmpeg absent (`PATH` reduced to `/usr/bin:/bin` plus an empty directory): printed the three-platform install block and exited **2**. `playwright-chromium` unresolvable (a `node --import` resolve hook throwing `ERR_MODULE_NOT_FOUND` for that specifier, leaving the installed package untouched): printed the `pnpm add -D` / `npx playwright install` block and exited **2**. Neither run started a dev server or bound a port — both preflights sit ahead of `startDevServer` (`video.ts:1107-1119`, `1121-1133` vs `1145`) |
| AC-12 | Output plays in ordinary players | PASS | Phase-4 `fb36586`: ffprobe reports `h264`, `yuv420p`, `1920x1080`, `30/1` on both a whole-deck and a per-page output |
| AC-13 | Resources released on every path | PASS | Thrown-error path: `closeAll` at `video.ts:1214`, `1218`, `1221`, exercised for real by the AC-26 run. Kill path measured twice against `video --slide slide-transitions --port 519x`, from a baseline of 0 Chromium processes and an unbound port. Mid-capture each run held 4 Chromium processes and a listening port. Five seconds after `SIGTERM`, and again five seconds after `SIGINT` (shell status 130): 0 Chromium processes, port unbound. There is still no explicit signal handler in `video.ts` or `export.ts`, so this confirms Playwright's own exit hooks carry it — now measured rather than assumed |
| AC-14 | Runtime bundle stays free of Playwright | PASS | `packages/core/dist/index.js`: 0 occurrences of `playwright`. Only live reference in the package is `await import("playwright-chromium")` at `dist/export-B0GUB4Yr.js:22`; `dist/video-BLzibE65.js` mentions it only inside the install message |
| AC-15 | Flags validated and documented | PASS | Mutual exclusion, `--page` without `--slide`, and `--fps 121` exit 2 through `validateFlags` (`video.ts:1075-1088`, `1101-1104`). `--fps 0`, `--page 0`, `--duration 0`, `--dwell -1`, `--timeout 0` and `--port 99999` now exit 2 through Commander (`run.ts:26`, `111`, `121`, `150-152`), measured against the real binary. Help shows one example per flag (`run.ts:264-274`). See G1 |
| AC-16 | Step-gated deck falls back to per-page and says so | PASS | Phase-4 `fb36586`: `build-on-reveal` warned naming p2/p3/p4, wrote five per-page MP4s and no deck file, exited 0, and its warning stated the four loop-variant elements verbatim. Warning composition at `video.ts:618-630` |
| AC-16a | Capture never advances past a pending step | PASS | Required-absence verified against the branch diff: `player.tsx`, `step-context.tsx`, `slide-transition-layer.tsx`, `app/lib/transition.ts` are all absent from `git diff 35dc46c...HEAD --name-only`. `capturePerPage` (`video.ts:963-983`) issues no key press. A gated page arrives fully revealed via `step-context.tsx:190` (`host?.entryDirection === 'forward' ? 0 : stepCount`), so no reveal transition can fire on a fresh mount |
| AC-17 | Frames match the fixed canvas | PASS | `video.ts:1164`, `751-754`; phase-4 `fb36586` ffprobe 1920x1080 |
| AC-18 | Duration clamped and overridable | PASS | Tests `resolveDurationMs clamps a runaway duration`, `resolveDurationMs honours the override` (asserts the override is itself clamped), `replaces every page duration with the override but leaves boundaries measured` |
| AC-19 | Every page reports what it captured | PASS | `video.ts:760-769`; phase-2 `198e40c` and phase-3 `e6ee19a` both quote per-page report output including animation counts |
| AC-20 | Flag and fallback produce the same per-page output | PASS | One derivation `video.ts:646-653`, matching `export.ts:87-90`'s padding convention exactly; tests `derives a page-level name for the per-page shape`, `derives the same name whether the shape came from the flag or the fallback`; phase-3 `e6ee19a`: `steps-in-motion` wrote 14 files named identically to a flagged run |
| AC-21 | Session continuous, each boundary completes | PASS | Single `goto` at `video.ts:925`; `waitForFunction(settleTransition)` at `822` before the next page. Phase-2 `198e40c`: no stranded outgoing layer across six advances; phase-3 `e6ee19a`: `morph-demo` final page clean after three morph boundaries |
| AC-22 | Reduced motion cannot silently remove the transitions | PASS | Pin at `video.ts:1166`; boundary segments non-empty in practice (phase-3 `e6ee19a` measured 280/280/540/320/280 ms on `slide-transitions`). Note: the Test Strategy's counterfactual (capture under an explicit `reduce` context and confirm the boundary collapses) has no recorded result, but both Gherkin clauses are evidenced |
| AC-23 | Empty deck reported, not encoded | PASS | Run as enumerated. A throwaway deck whose default export is `[]` was added to `apps/demo/slides/` and `--all` was run over the workspace. stderr: `zzz-empty-fixture: 0 pages — skipped (deck is empty, or its default export could not be parsed)`. The run exited **0**, wrote no file bearing that id, and produced 37 MP4s from the other 20 decks. Fixture removed afterwards; `git status` carries no trace of it. Path: `video.ts:1150-1154` |
| AC-24 | Intermediate frames do not survive a successful run | PASS | `video.ts:1197`; phase-4 `fb36586`: `build-on-reveal` left no frame directory; the `--keep-frames` half is exercised throughout the AC-10 determinism runs |
| AC-25 | A changeset accompanies the change | PASS | `.changeset/wild-pumas-film.md` — `minor` bump, one present-tense line describing the new subcommand |
| AC-26 | Runtime failures exit 1 | PASS | Run. `chmod 500` on an existing `--out` directory, then `video --slide vercel-ai-sdk --page 1`: the run reached capture, failed with `EACCES: permission denied, mkdir '.../ac26/.frames-vercel-ai-sdk'`, printed that single line to stderr with no stack trace, and exited **1** — distinct from the 2 every usage and preflight error returns. Path: caught at `video.ts:1216-1219`, after `closeAll` |
| AC-27 | Mixed run produces both shapes and is legible | PASS | Run end to end. One `--all` invocation over the 20-deck demo workspace, which holds two step-gated decks and eighteen plain ones: `Rendered 167 page(s) from 20 deck(s)`, 37 MP4s, exit **0**. The summary named the shape per deck — `build-on-reveal — 5 MP4(s) (per page, step-gated fallback)` and `steps-in-motion — 14 MP4(s) (per page, step-gated fallback)` against eighteen `— 1 MP4 (whole deck)` lines — and 18+5+14 = 37 reconciles the file count. Both fallbacks emitted the loop-variant warning on stderr. Path: `video.ts:1203`, `1210`, `595-604` |
| AC-28 | Loop-variant wording cannot drift | PASS | Constant `video.ts:133-138`; warning composes at `video.ts:628`; spec `video.test.ts:294-308` reads `loop-variant.md` off disk and fails if any element disappears — confirmed passing and confirmed reading the real path (`packages/core/skills/slide-authoring/references/loop-variant.md:9-12`) |

## Test Strategy Verification

All 23 rows specified in the CR exist in `packages/core/src/cli/video.test.ts` and
pass. The file now carries 54 specs (31 beyond the CR's table), and
`packages/core/src/cli/run.test.ts` carries 14, of which 10 are the exit-code
regression added for G1.

| Test File | Test Name | Specified | Exists | Matches Spec |
|---|---|---|---|---|
| `video.test.ts` | `resolveDurationMs uses the measured value` | yes | yes (`:45`) | yes |
| `video.test.ts` | `resolveDurationMs falls back when nothing is measurable` | yes | yes (`:49`) | yes |
| `video.test.ts` | `resolveDurationMs clamps a runaway duration` | yes | yes (`:53`) | yes |
| `video.test.ts` | `resolveDurationMs honours the override` | yes | yes (`:57`) | yes |
| `video.test.ts` | `frameCountFor never returns zero` | yes | yes (`:65`) | yes |
| `video.test.ts` | `frameCountFor scales with fps` | yes | yes (`:69`) | yes |
| `video.test.ts` | `planDeckTimeline orders pages and applies dwell` | yes | yes (`:76`) | yes |
| `video.test.ts` | `planDeckTimeline applies one dwell to every page` | yes | yes (`:91`) | yes |
| `video.test.ts` | `planDeckTimeline emits a transition segment from a measured boundary` | yes | yes (`:112`) | yes |
| `video.test.ts` | `planDeckTimeline emits no transition segment for a single page` | yes | yes (`:131`) | yes |
| `video.test.ts` | `planDeckTimeline emits no transition segment for a zero-length boundary` | yes | yes (`:141`) | yes |
| `video.test.ts` | `stepGatedPages flags pages with a non-zero step count` | yes | yes (`:259`) | yes |
| `video.test.ts` | `stepGatedWarning names the pages, the shape change, and the loop variant` | yes | yes (`:269`) | yes — asserts pages, `2 of 5`, per-page shape and reason, fully-revealed capture, and all four elements |
| `video.test.ts` | `outputShapeFor picks per-page when any page is step-gated` | yes | yes (`:311`) | yes |
| `video.test.ts` | `outputShapeFor picks whole-deck when no page is step-gated` | yes | yes (`:315`) | yes |
| `video.test.ts` | `outputShapeFor picks per-page when --per-page is passed` | yes | yes (`:319`) | yes |
| `video.test.ts` | `frameFilenameFor sorts lexically` | yes | yes (`:325`) | yes — indices 9, 10, 100 |
| `video.test.ts` | `videoFilenameFor derives a deck-level name` | yes | yes (`:334`) | yes |
| `video.test.ts` | `videoFilenameFor derives a page-level name for the per-page shape` | yes | yes (`:338`) | yes |
| `video.test.ts` | `LOOP_VARIANT_ELEMENTS matches the slide-authoring reference` | yes | yes (`:295`) | yes — `readFileSync` off disk, all four elements |
| `video.test.ts` | `validateFlags rejects --slide with --all` | yes | yes (`:430`) | yes |
| `video.test.ts` | `validateFlags rejects --page without --slide` | yes | yes (`:434`) | yes |
| `video.test.ts` | `validateFlags rejects an out-of-range fps` | yes | yes (`:438`) | yes — `fps = 0` and `fps = 121`. This spec calls the function directly, so it cannot see what Commander does with the rejection; that is now covered separately in `run.test.ts`, see G1 |

Additional specs beyond the CR's table (all passing): `defaults dwell to 1500ms`,
`planDeckTimeline clamps a runaway boundary`, `replaces every page duration with
the override but leaves boundaries measured`, the `planPageSegment and
planTransitionSegment` block, `outputShapeSummary` block, `seekTimeMsFor` block,
`totalFrameCount`, `SETTLED_ANIMATION_ID`/`BOUNDARY_ANIMATION_ID` literal guards,
`boundary identification`, `slideCaptureUrl`, `stepCountsByPage`, the
`infinite animations` block and `settleTransition tagging` (both added for G3 and
G6, both run the browser-side helpers against a stubbed animation set),
`groupTargetsByDeck`.

## Diff Coverage

CR-0003's own commits are `63d219b`, `198e40c`, `e6ee19a`, `fb36586`, `6d7c798`,
`959a994`, `0a56551`, plus `a2a86df`/`ae961bb` (CR authoring/review, which also
landed the prototype `video.ts`), plus the gap-fix pass on top of `8dbcd3f`. Range
used: `a2a86df^...HEAD` — 13 files. The gap-fix pass itself is 5 files,
+266 / -10, entirely inside `packages/core/src/cli/`.

The wider `35dc46c...HEAD` merge-base diff additionally carries the CR-0001 and
CR-0002 file sets (`export-png*`, `cli/export*`, `app/routes/slide.tsx`,
`print-ready.ts`, `png-progress-toast.tsx`, the `docs/cli/*.mdx` pages, …), all of
which were validated by `docs/cr/CR-0001-validation-report.md` and
`docs/cr/CR-0002-validation-report.md` and are out of this CR's scope.
`app/routes/slide.tsx` was confirmed to have last changed in `3228ed3`, a CR-0002
commit, so it is consumed-as-is by CR-0003 as the CR declares.

| File | +/- | Mapped Requirements |
|---|---|---|
| `packages/core/src/cli/video.ts` | +1228 / -2 | FR-1, FR-4, FR-8 through FR-33, FR-35 through FR-41; NFR-1, NFR-2, NFR-3, NFR-4, NFR-8 |
| `packages/core/src/cli/video.test.ts` | +585 | NFR-4, NFR-8; the 23 Test Strategy rows; FR-17, AC-6, FR-13 |
| `packages/core/src/cli/run.ts` | +103 / -5 | FR-1, FR-2, FR-3, FR-5, FR-6, FR-7, FR-19, FR-29, FR-31, FR-34 |
| `packages/core/src/cli/run.test.ts` | +79 / -2 | FR-31, AC-15 — the exit-code regression added for G1 |
| `packages/core/src/cli/export.ts` | +9 / -1 | NFR-2 — exports `DEFAULT_TIMEOUT_MS`; no behavioural change |
| `.changeset/lazy-moons-shave.md` | +5 | NFR-7 — `patch`, for the exit-code change the G1 fix lands on the existing `export` subcommand |
| `.changeset/wild-pumas-film.md` | +5 | NFR-7, AC-25 |
| `README.md` | +12 | Documentation checklist ("CLI reference entry added to `README.md`") |
| `packages/core/skills/slide-authoring/references/loop-variant.md` | +27 | NFR-8, AC-28, FR-36 |
| `packages/core/skills/slide-authoring/SKILL.md` | +7 | NFR-8 ("Primitive references" row plus summary section) |
| `docs/cr/CR-0003-cli-capture-deck-as-video.md` | +1434 | The CR itself |
| `package.json` | +1 | Dependencies section: `playwright-chromium` devDependency at `~1.56.1` (FR-32) |
| `pnpm-lock.yaml` | +3 | Lockfile for the above |
| `.gitignore` | +2 | Undeclared but justified — ignores `png-export` and `video-export` so capture output is not committed |
| `apps/demo/slides/governance-loop/index.tsx` | +783 | Accepted incidental branch content per explicit maintainer decision; not a CR-0003 deliverable |

### Unmapped changed files

- `.gitignore` (+2) — undeclared in Affected Components. Justified: adds
  `png-export` and `video-export`, the default output directories of the two
  capture subcommands. Not treated as scope creep.
- `apps/demo/slides/governance-loop/index.tsx` (+783) — accepted incidental branch
  content per explicit maintainer decision. Not a deliverable of this CR, not
  declared, and not treated as undeclared scope. One observation recorded below.
- `packages/core/src/cli/export.ts` — touched by the gap-fix pass. Declared in the
  CR's Affected Components as "consumed as is, no change", and the change is one
  `export` keyword plus its docstring: no behaviour of the `export` subcommand
  moves. Recorded here rather than treated as scope creep, since NFR-2 cannot be
  satisfied without it. The parallel `run.ts` fix does change the `export`
  subcommand's exit code for a malformed `--page` / `--timeout` / `--port`, from 1
  to 2 — that is the same defect in the same shared parser, and leaving a
  known-wrong sibling behind would have been the worse outcome.

### Declared but deferred (not gaps)

- `apps/web/content/docs/cli/video.mdx` (new) — does not exist. Deliverable of the
  doc-updater, which runs after validation.
- `apps/web/content/docs/cli/meta.json` — not updated for `video`. Same owner,
  same deferral.

## Gaps

All six are closed. Each entry keeps the original finding and records what was
changed and what was measured to close it.

**G1 — CLOSED. `--fps 0` (and the other lower-bound argParsers) exited 1, not 2.**
Refs: FR-31, AC-15, FR-6.
Finding: `run.ts`'s argParsers threw a plain `Error`. Commander converts only its
own `InvalidArgumentError` into a usage exit; a plain `Error` propagated out of
`parseAsync` to `bin.ts:5-9`, which printed it and called `process.exit(1)`. So
`--fps 0`, `--page 0`, `--duration 0`, `--dwell -1` and `--timeout 0` exited 1
where FR-31 and AC-15 require 2. `--fps 121` was unaffected because it reaches
`validateFlags`.
Fix: two parts, because the first alone is not sufficient. `parsePort`,
`parsePositiveInt` and `parseNonNegativeInt` now throw `InvalidArgumentError`
(`run.ts:26`, `111`, `121`) — but Commander's own default exit code for a usage
error is also 1, and the subcommands reserve 1 for runtime failure, so
`run.ts:150-152` adds a program-level `exitOverride` remapping every non-zero
Commander exit to 2 while leaving 0 alone. It is declared before the first
`.command()` call because `copyInheritedSettings` snaps the callback onto each
subcommand at creation time. `parsePort` was fixed alongside the other two: it is
the same defect in the same family and `video --port` is in scope for FR-31.
The `export` subcommand shares all three parsers, so its malformed-flag exits move
from 1 to 2 as well. That is a deliberate consequence — see the Diff Coverage note.
Coverage: `run.test.ts` now drives `run(argv)` through Commander with
`process.exit` stubbed, asserting 2 for six malformed video flags, 2 for two
malformed export flags, 2 for an unknown subcommand, and 0 for `--help`,
`--version` and `video --help`. Confirmed to catch the defect: with the parsers
reverted to `throw new Error`, 8 of the 14 specs in that file fail. Also confirmed
against the real binary, which is what actually exits.

**G2 — CLOSED. NFR-2 single-sourcing shortfall.**
Refs: NFR-2.
Finding: `DEFAULT_TIMEOUT_MS = 15_000` was declared independently in `export.ts`
and `video.ts`. Separately, font readiness had two definitions in the package.
Fix: `export.ts:41-49` now exports the constant with a docstring saying why, and
`video.ts:42` imports it; `video.ts` declares no timing constant `export.ts` owns.
No behaviour of `export.ts` changes — the added `export` keyword is the whole
change. The second font predicate is kept, because FR-21 forbids this capture from
gating on the readiness flag `print-ready.ts`'s `waitForFonts` is reached through;
`video.ts:695-701` now states the divergence and, explicitly, that the polled
`status` check is the weaker of the two and why that is acceptable here.

**G3 — CLOSED. FR-17 / AC-6 had no behavioural evidence.**
Refs: FR-17, AC-6.
Finding: the infinite-animation rule had neither a unit spec nor a recorded
capture.
Fix: no source change — the behaviour was already correct. Two specs now run
`pauseAndMeasure` and `seekTo` against a stubbed animation set under the node
environment: an infinite animation is paused and counted but contributes no
duration, and it is seeked along with everything else while a settled-tagged one
is not.
Capture: `apps/demo/slides/vercel-ai-sdk` page 1 carries
`vai-pulse 2.4s ease-in-out infinite`. It measures `5 animation(s), 1500ms` — the
infinite one contributes nothing to the duration. Forced to `--duration 4000
--dwell 0 --fps 10 --keep-frames`, the 20 frames beyond 1500 ms, past the end of
every finite animation on the page, hold 13 distinct images, and pairs at
2000/2600/3200/3900 ms and adjacent frames at 3000/3100 ms all differ. Nothing
else on that page can move at those offsets.

**G4 — CLOSED, with one honest limit. AC-8 clauses 2 and 3.**
Refs: AC-8, FR-8.
Finding: clause 3 ("a deck declaring no transition produces no boundary frames")
and clause 2 ("the boundary frames match what the viewer renders at the same
offsets") had no recorded result.
Clause 3, measured: `vercel-ai-sdk` declares no transition. Its whole-deck capture
reported `no transition declared` at all seven boundaries and wrote 64 frames,
exactly 9+8+6+9+7+7+10+8 — the sum of the page segments, with nothing added at any
boundary.
Clause 2, measured at the endpoints: on `slide-transitions`, each boundary's t=0
frame is byte-identical to the outgoing page's settled frame, which is what the
viewer renders at offset 0; the far end is produced by `settleTransition` calling
the viewer's own `finish()`, not by a seek, and appears as the first frame of the
next page segment. The offsets in between are produced by writing `currentTime` on
the viewer's own animation objects.
Residual limit, stated rather than papered over: there is no independent renderer
to diff the interior offsets against, so "match what the viewer renders" is
verified at both endpoints and by construction in between, not by comparison. If
the maintainer wants a stronger claim, AC-8 clause 2 needs rewording to the
by-construction argument FR-8 and NFR-3 already establish — that is a CR
amendment, so it is surfaced here rather than made.

**G5 — CLOSED. AC-10a clause 3 had no recorded measurement.**
Refs: AC-10a, FR-24.
Finding: "no boundary segment is byte-identical to the settled frame repeated" was
inferred from the antialiasing variance, not asserted.
Measured: `slide-transitions` at 10fps with frames retained. The five boundary
segments hold 3/3, 3/3, 4/5, 3/3 and 3/3 distinct images. The control is the
adjacent page segment: 33 frames collapsing to 1 distinct image, since those pages
carry no animation. No boundary frame equals the incoming settled frame; at most
one per boundary equals the outgoing settled frame, always its t=0 frame, and
`p4→p5` matches neither. So no boundary segment is a repeated still.

**G6 — CLOSED. Five acceptance criteria rested on file:line evidence only.**
Refs: AC-11, AC-13, AC-23, AC-26, AC-27.
Finding: AC-11, AC-13, AC-23, AC-26 and AC-27 each had an enumerated Test Strategy
step and no recorded result anywhere in the checkpoint trail.
All five run; the numbers are in the rows above. Briefly: ffmpeg removed from
`PATH` → exit 2 with the install block, no dev server started; `playwright-chromium`
made unresolvable by a `node --import` resolve hook → exit 2 with the install
block; an unwritable `--out` directory → a single `EACCES` line on stderr and exit
1; a throwaway zero-page deck under `--all` → named on stderr, skipped, exit 0, no
file written for it; one `--all` over the 20-deck workspace → 167 pages, 37 MP4s,
two decks per-page by fallback and eighteen whole-deck, each named in the summary.
AC-13's kill path was measured twice from a clean baseline: mid-capture, 4 Chromium
processes and a bound port; five seconds after `SIGTERM`, and again after `SIGINT`,
0 Chromium processes and the port free. There is still no explicit signal handler
in `video.ts` or `export.ts` — the reliance on Playwright's exit hooks is now a
measured fact rather than an assumption.

**G7 — CLOSED (was an observation, not a gap). Boundary tag survived a throwing
`finish()`.**
Refs: FR-13.
The first pass recorded, under Observations, that neither `pauseAndMeasure` nor
`measureBoundary` skips `BOUNDARY_ANIMATION_ID`: they rely on `settleTransition`
having retagged first. A `finish()` that throws — caught at `video.ts:400` — would
leave the boundary tag in place, and the next page would then measure and seek a
leftover transition animation as its own content, silently. That is precisely the
class of silent failure this CR exists to prevent, so it is hardened rather than
documented as an accepted invariant: `settleTransition` now assigns
`SETTLED_ANIMATION_ID` *before* calling `finish()` (`video.ts:397-401`). The retag
costs nothing on the retry path, because the function is polled by
`waitForFunction` and re-identifies a settled-tagged boundary animation by target
on every subsequent call. Alternatives considered and rejected: skipping the
boundary tag in `pauseAndMeasure` too (a third copy of the predicate, and it would
mask a genuinely stranded boundary rather than settle it), and documenting the
ordering as an invariant (cheaper, but leaves a silent wrong-output path live).
Coverage: spec `settleTransition tagging retags a boundary animation whose finish
throws, so the next page cannot measure it`, confirmed to fail against the old
ordering.

## Observations (not gaps)

- **The AC-10 amendment is coherently propagated.** FR-24 (`CR:291`) states the
  split by segment kind with `YMAX <= 160` / `YAVG <= 1.0`; AC-10 (`CR:656-664`)
  carries the byte-identity half; AC-10a (`CR:666-704`) carries the perceptual half
  with the measured basis and the reasoning for both thresholds; Risk 12
  (`CR:1098-1114`) records that capturing the viewer's transitions rather than
  composing them at encode time is what introduced the variance. Risk 4, Risk 8,
  Motivation, Change Drivers, Technical Impact, In Scope, the Quality Standards
  checklist, and the README paragraph were all qualified to match. No unqualified
  determinism claim survives.
- **Animation tagging is still honoured by ordering, but the ordering no longer
  has a silent failure mode.** `pauseAndMeasure` (`video.ts:215`),
  `measureBoundary` (`:257`) and `seekTo` (`:296`) all skip
  `SETTLED_ANIMATION_ID`; `seekTo` honours `BOUNDARY_ANIMATION_ID` via
  `boundaryOnly` (`:297`); `settleTransition` (`:380`) accepts the boundary tag and
  retags to settled. Neither `pauseAndMeasure` nor `measureBoundary` skips
  `BOUNDARY_ANIMATION_ID` — they still rely on `settleTransition` having retagged
  first, which `captureBoundary` guarantees by gating on
  `waitForFunction(settleTransition)` (`:822`) before the next `capturePage`. The
  throwing-`finish()` hole in that reliance was filed and fixed; see G7.
- **The init-script sweep is the one path that does not consult tags.**
  `pauseAllAnimations` (`video.ts:325-334`) pauses any animation whose `playState
  !== 'paused'`, which includes settled boundary animations (`playState`
  `'finished'`). This is harmless — `finished` has already resolved, so
  `SlideTransitionLayer`'s unmount handler has already fired, and
  `settleTransition` confirms the unmount from the DOM (`:404`) rather than from
  the animation set. Matches what Risk 9 predicted.
- **`apps/demo/slides/governance-loop/index.tsx:10-11` carries the framing the CR
  corrected.** Its docstring says a `<Step>`-driven deck "registers no animations
  until a presenter advances it, and captures as a still". The CR's Open Questions
  section (`CR:1195-1207`) established that a directly loaded page arrives with
  every step already revealed, so the fallback loses reveal motion and inter-page
  transitions, not content. The file is accepted incidental branch content and out
  of CR-0003's scope, so this is recorded for whoever next edits that deck rather
  than filed as a gap.
