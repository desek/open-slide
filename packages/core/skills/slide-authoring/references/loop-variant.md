# Loop variant (a deck authored for capture)

A **loop variant** is a sibling deck built to be recorded rather than presented. `open-slide video` captures a deck as a single MP4 by seeking every animation frame by frame, but it never drives a step: a deck with a step-gated page falls back to one MP4 per page, because a continuous capture cannot advance past a pending step without walking its reveals. A loop variant is the route back to one file. Author it when the deliverable is a video for a README header, release notes, a docs page, or a social post, where nobody is there to press `→`.

Keep the presented deck as it is. A loop variant is a *second* deck (`slides/<id>-loop/`), not an edit of the first: the presented deck wants a presenter's pacing, the loop variant wants a fixed timeline.

## The four elements

1. **Step reveals replaced by time-based animations.** Drop `<Steps>` / `<Step>` entirely and stage the same beats with CSS keyframes carrying staggered `animation-delay`. The capture measures each page from its longest finite animation, so the stagger *is* the pacing. This is the load-bearing element: any `<Step>` left in the deck sends the whole deck back to per-page output.
2. **Transitions declared between pages.** Give the deck a module-level `SlideTransition` (per-page overrides where a page earns one). The capture seeks the viewer's own transition at each boundary, so an undeclared transition is a hard cut in the file. See `transitions.md` for the contract and the tasteful family; `morph.md` if a shared element carries across a boundary.
3. **Pages that advance automatically instead of on input.** With no step gate left, the capture advances the deck itself: each page contributes its measured animation followed by the run-wide `--dwell` hold, then the boundary. Author each page so it reads fully in that window rather than assuming someone will linger on it.
4. **A closing transition into the first page's background, so the file plays as a seamless loop.** This needs an extra page, and that is not obvious. A transition attaches to the page being entered, so the deck's last content page never gets an outgoing one — the capture walks pages in order and stops. Add a final wrap page holding nothing but the background, and put the closing transition on *that* page. Without it there is no closing boundary at all, however carefully the last page's transition is authored.

   The wrap page also has to match what frame 0 actually renders, which is *not* the first page: every `both`-filled entrance is at `opacity: 0` before it starts, so frame 0 is the bare background. A wrap page rendering the same bare background makes the first and last frames identical, and the loop point disappears. Give it one short animation — a page with no finite animation takes the 3 s fallback (see below) and holds an empty screen for far longer than a beat.

## Authoring notes

- **One motion DNA across the deck.** The video makes inconsistency far more obvious than a live presentation does, because every boundary plays back to back with no talking over it.
- **Budget the timeline.** Total length is the sum of each page's measured animation plus `--dwell` plus each boundary. A ten-page loop variant at the 1500 ms default dwell already runs past 20 seconds, which is long for a README header. Fewer, denser pages beat more, thinner ones.
- **A page with no finite animation costs 3 s, not the dwell.** With nothing finite to measure, the capture falls back to a fixed 3 s and *then* adds the dwell, so a "quick" static page is the most expensive one in the deck. One short animation is enough to set its length explicitly.
- **An ambient animation still sets the page's length.** Page duration is the longest finite animation, so a slow background turn timed to cover the dwell becomes the measurement and inflates every page it is on. Keep ambient motion inside the window the content already needs.
- **Infinite animations reset at every cut.** They are excluded from the duration measurement, which makes them look like the right tool for ambient motion — but the runtime mounts a *fresh* instance of the outgoing page during a boundary, and a fresh mount restarts an infinite animation at zero. The motion visibly snaps back at every boundary. For anything that should carry across a cut, use a finite animation whose resting style is its own end state, and start the next page's from where the last one ended.
- **Capture it with `open-slide video --slide <id>-loop`.** Add `--keep-frames` while iterating and look at the frames directly; that is far faster than re-watching the MP4 to find the page that mistimed.

## The snapshot contract

During every boundary the runtime mounts a **second, fresh instance of the outgoing page** to snapshot its exit state (`morph.md` rule 5), and the dev UI mounts more for thumbnails and overview. Gate entrances behind `useIsActivePage()` so those instances render settled instead of replaying. Three consequences bite specifically in a loop variant, and every one of them produces a valid MP4 of the wrong thing.

- **A resting style must equal the settled state — including for exits.** A frozen instance renders base styles, so the freeze only tells the truth when the base style *is* where the animation ends. Entrances satisfy this for free (they end where they rest). An exit does not: an element that crushes or fades *away* rests visible, so it reappears intact on the outgoing snapshot — the content flashing back at the exact moment the page finished removing it. Give every exit a resting style matching its end (`opacity: 0`, the final transform).
- **A `<style>` element is document-wide, not scoped to the subtree that rendered it.** A freeze stylesheet mounted by the outgoing snapshot therefore disables the *incoming* page's entrances for the whole boundary. That page renders fully settled while the transition plays, then snaps back and replays the moment the outgoing layer unmounts — which reads as the deck showing its answer before animating it. Scope the rule to an attribute the frozen instance carries (`[data-frozen] :is(.a, .b) { animation: none !important; }`).
- **Freeze the morph overlay too.** A clone is meant to be a still snapshot the runtime glides. Left animating, its entrances run inside the overlay, and because the capture treats everything under the overlay as part of the boundary, the longest of them is measured as the boundary's duration — one panel finishing at 2.2 s turns a 640 ms cut into a 2.2 s one.

## Morph in a loop variant

`morph.md` governs the mechanism; two things matter more here than in a presented deck.

- **Clones travel above both pages.** Morphed decoration whose path crosses foreground content draws *over* it for the length of the boundary, which reads as the background jumping to the front. Either keep the two apart in the layout or don't morph the decoration.
- **Only morph what is genuinely the same object.** A panel whose text differs on the two pages is two objects wearing one id; the glide then carries the old content into the new slot. Continuity of *shape* is not continuity of *meaning*.

## Verifying a loop

Nothing here fails loudly, so check the artifact rather than the intent.

- **Measure the seam.** Extract the first and last frames and diff them: `ffmpeg -i a.png -i b.png -filter_complex "blend=all_mode=difference,signalstats,metadata=print" -f null -`. `YMAX` near 0 means the loop closes. A large `YMAX` means the wrap page and frame 0 disagree.
- **Read the per-page report.** The capture prints an animation count per page. A page reporting 0 is step-gated or already settled, and will capture as a still.
- **Watch for a boundary that measures far longer than the others.** That is almost always a content animation being counted as part of the transition.
- **Look at frames across a boundary, not just at settled pages.** Every defect in this reference was invisible in a settled frame and obvious three frames into a cut.

## Anti-patterns

- **Keeping `<Steps>` "just on one page."** One gated page changes the output shape for the entire deck.
- **Editing the presented deck into a loop variant.** You lose the presenter-paced version, and step reveals and time-based reveals want genuinely different content density.
- **Long, cinematic transitions.** The 140–280 ms band from `transitions.md` still holds. A video does not license a 900 ms wipe.
- **Ending on a page that looks nothing like the cover.** Without the closing transition into the first page's background, the loop is visible as a jump cut, which is exactly what the variant exists to avoid.
- **Two classes both setting the `animation` shorthand on one element.** Equal specificity means the later rule wins outright — shorthands do not merge — so `class="fade-in spin"` silently drops whichever rule the stylesheet declares first. Put ambient motion on an inner element and the entrance on the wrapper.
- **Trusting a settled screenshot.** A PNG export catches layout and overflow; it cannot catch a reset at a cut, a replay after a boundary, or a loop that does not close. Those only exist in motion.
