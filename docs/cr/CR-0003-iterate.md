---
cr: "CR-0003"
name: cli-capture-deck-as-video
kind: iterate-ledger
date: 2026-07-29
branch: feat/export-slides-as-video
backfilled: true
---

# CR-0003 — the last mile

Backfilled after the fact, so the attempts are reconstructed from the commits,
the captures, and the frames rather than logged as they happened. Ordering is
faithful; wording is not verbatim.

Scope is wider than the CR itself. Once `open-slide video` existed it was pointed
at a real deck, and the deck immediately found defects the test suite could not:
everything in the "capture" and "deck" sections below was discovered by looking
at frames, never by an error. That is the single most useful thing this ledger
records.

## Design

### Attempt 1 — compose inter-page transitions at encode time

A crossfade built by an ffmpeg filter graph, adjustable without re-capturing.

**disposition:** discarded
**why:** it defines "transition" a second time, alongside the viewer's existing
transition module, and the two would drift. A captured deck would stop looking
like the deck. Morph in particular cannot be reproduced by a filter graph at all.

### Attempt 2 — capture the viewer's own transitions instead

Advance the deck in place and seek the animations `slide-transition-layer.tsx`
creates.

**disposition:** kept
**why kept, and what it cost:** the output is what the viewer renders, and the
transition vocabulary stays single-sourced. It also turned the capture into one
continuous browsing session rather than independent page loads, and it is the
direct cause of Attempt 4. An encode-time crossfade would have been
byte-deterministic by construction.

### Attempt 3 — add a step-bypassing path to the viewer

Let the capture jump past a page's pending steps so step-gated decks could still
produce one file.

**disposition:** discarded
**why:** it would have made a rendering concern into a viewer change and put an
automation surface on `player.tsx`. Falling back to per-page output for
step-gated decks costs a second output shape but keeps the CR purely additive.

### Attempt 4 — assert byte-identical frames across runs (AC-10 as written)

**disposition:** partially-kept
**why:** page and dwell segments are byte-identical; transition boundaries are
not. Measured `slide-transitions` at 10 differing frames of 860 (YMAX 93 / YAVG
0.16) and `morph-demo` at 1 of 654 (YMAX 1) — edge antialiasing on
scale-animated compositor layers, which rasterise to one of two stable variants
per run. Split into AC-10 (byte-identity for page and dwell) and AC-10a
(YMAX ≤ 160 / YAVG ≤ 1.0 for boundaries) rather than weakening the whole thing.

## Implementation

### Attempt 5 — pause every animation on an interval, unconditionally

**disposition:** partially-kept
**why:** correct in principle, but `pause()` on an already-paused animation
re-commits it to the compositor, and a re-commit landing between a seek and its
screenshot re-rasters the layer. At 250 calls a second that made boundary frames
differ between runs. A `playState` guard fixed the frequent case; it did not fix
the mechanism, which is Attempt 4.

### Attempt 6 — treat a finished animation as gone

**disposition:** discarded
**why:** a finished animation with a forwards fill stays in
`document.getAnimations()`. A settled enter transition was being measured as the
*next* page's content duration, and the per-frame seek then reset it to zero —
replaying the transition underneath the page it had just joined. Valid MP4,
wrong content, no error. Fixed by tagging settled and boundary animations and
skipping tagged ones in every path that enumerates.

### Attempt 7 — throw `Error` from the Commander arg parsers

**disposition:** discarded
**why:** two layers were wrong, not one. Commander only converts
`InvalidArgumentError` into a code-2 exit — and its own default exit for a usage
error is also 1, so fixing the throw was still insufficient. Needed a
program-level `exitOverride`. The spec that should have caught this called
`validateFlags` directly and never traversed Commander; the replacement drives
`run(argv)` and fails 8 of 14 against the old code.

## Capture, found by pointing it at a real deck

### Attempt 8 — assume `Cta.transition` was dead code

Diagnosis: the deck's closing transition never fired because nothing followed the
last page.

**disposition:** discarded
**why:** wrong, and the evidence was already in hand. A transition governs the
boundary *into* its page, so `Cta.transition` had been firing at p6→p7 all along
— visible in the very first capture as a 700 ms boundary among 580 ms ones. The
real gap was that the deck had no boundary *after* its last page. The fix
(Attempt 9) was right for a reason I had stated incorrectly, and the bad
diagnosis then put a 1100 ms wrap morph on the wrong boundary until a later
capture caught it.

### Attempt 9 — add a wrap page so the deck has a closing boundary

**disposition:** kept
**why:** the capture walks pages in order and stops, so a closing transition only
exists if there is a page left to leave for. A wrap page rendering the bare
background also matches frame 0 — every `both`-filled entrance sits at
`opacity: 0` before it starts — which took the loop seam to YMAX 0.

### Attempt 10 — mount the freeze stylesheet with `{!active && <style>…}`

**disposition:** discarded
**why:** the highest-value finding in the session. A `<style>` element applies
document-wide, not to the subtree that rendered it. The outgoing page's snapshot
instance therefore disabled the *incoming* page's entrances for the whole
boundary: every page rendered fully settled during the cut, then blanked and
replayed the moment the outgoing layer unmounted. Reported as "shows everything
first, then animates". Fixed by scoping to `[data-g-frozen]`.

An earlier hypothesis — that `useIsActivePage()` returned false on the incoming
layer — was tested against `slide-transition-layer.tsx` and disproved
(`isActivePage` is unconditionally true there) before the real cause was found by
reading frames across a boundary.

### Attempt 11 — scope the freeze to the frozen page only

**disposition:** partially-kept
**why:** it fixed the flash and immediately exposed a second defect. Morph clones
live in `[data-osd-morph-layer]`, which the capture treats as boundary scope, so
a clone's own entrances were measured as the boundary's duration — one 640 ms cut
became 2200 ms, exactly the ledger panel's line timings. The global freeze had
been masking it. Both scopes are now frozen.

## Deck authoring

### Attempt 12 — `className="g-pop g-spin"`

**disposition:** discarded
**why:** two classes setting the `animation` shorthand at equal specificity do
not merge — the later rule wins outright, so the pop entrance never existed on
any of the three accent solids. Silent, and only observable in a browser. Spin
moved to an inner element.

### Attempt 13 — infinite rotation for ambient motion

**disposition:** discarded
**why:** the runtime mounts a fresh instance of the outgoing page at every
boundary, and a fresh mount restarts an infinite animation at zero. The solid
visibly snapped back at every cut. Replaced by a finite turn whose resting style
is its own end angle, chained across pages so the morphed solid carries its angle
through the glide.

### Attempt 14 — time the ambient turn to cover the page plus its dwell

**disposition:** discarded
**why:** page duration is the longest finite animation, so the turn *became* the
measurement and inflated the deck from 31.0 s to 36.6 s. Refitted inside each
page's existing content window; the solids now hold still through the dwell.

### Attempt 15 — morph the ledger panel across the squash merge

The CR's own notes called this the highest-value change in the deck: the survival
argument made by motion rather than asserted by copy.

**disposition:** discarded
**why:** the panel's text differs on the two pages, so the id paired two objects
that merely looked alike, and the glide carried the old content into the new
slot. Continuity of shape is not continuity of meaning. The same reasoning
retired the console morph on the preceding boundary.

### Attempt 16 — morph the accent solid from the payoff page into the closing page

**disposition:** kept
**why:** genuinely the same object — same seed, same segment count, only position
and radius differ. It carries the boundary alone while everything else fades.

### Attempt 17 — leave crushed commits at their default resting style

**disposition:** discarded
**why:** crush is the deck's only *exit* animation, so its settled state is
*gone*, but its resting style said visible. The outgoing snapshot renders resting
styles, so all six commits flashed back at the exact moment the page had finished
arguing they were destroyed. Exits now rest at `opacity: 0`.

### Attempt 18 — place backdrop planes wherever the composition wanted

**disposition:** discarded
**why:** the planes morph, so the runtime clones them into an overlay that by
design travels above both pages. A plane whose path crossed an accent solid drew
its wireframe over that solid mid-cut, reading as the background jumping to the
front. Planes now avoid the band the solids occupy — a positional constraint that
will silently return if a future plane is placed under one.

## What this leaves

- Boundary frames are reproducible only to within antialiasing (AC-10a). Not
  chased; the cause is compositor rasterisation, not the capture.
- The loop seam is YMAX 6 / YAVG 0.025 rather than 0, because the backdrop is
  morph-composited on the wrap page. Invisible, but no longer exact.
- A morph clone cannot rotate during its glide without resetting to zero, since a
  cloned element's CSS animation restarts. Frozen at the outgoing angle is the
  better of the two.
- `apps/web/content/docs/cli/overview.mdx` advertises template scripts that
  `packages/cli/template/package.json` does not define — pre-existing, from
  CR-0002.
- The deck's `meta.createdAt` is still a placeholder.

## Distilled

Promoted into `packages/core/skills/slide-authoring/references/loop-variant.md`
(commit `35ca221`), which was written before a loop variant existed and had three
claims that did not survive building one: that the closing transition belongs on
the last page, that infinite animations suit ambient motion, and that a page with
no finite animation costs only the dwell. The snapshot contract — resting styles
must equal settled state including for exits, freeze stylesheets must be scoped,
freeze the morph overlay — is new material from Attempts 10, 11 and 17.
