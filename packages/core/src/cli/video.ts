/**
 * @agents-index `open-slide video` subcommand — seeks each page's CSS
 * animations frame by frame in headless Chromium and encodes the captured
 * frames to an MP4 with ffmpeg.
 *
 * This is the moving-image counterpart to `export.ts`, and it deliberately
 * reuses that module's dev-server boot, deck enumeration, target resolution and
 * atomic writes rather than forking them. The only genuinely new problem here
 * is time.
 *
 * The PNG exporter waits for animation to *finish* so it can capture a settled
 * frame. Video needs the opposite: samples taken mid-flight at exact instants.
 * Decks animate with wall-clock CSS keyframes and expose no playhead, so the
 * frames cannot simply be screenshotted on a timer — a screenshot loop samples
 * whenever the screenshot happened to land, which drops and duplicates frames
 * under load and never reproduces.
 *
 * The fix is the Web Animations API. Every running animation is paused and its
 * `currentTime` is driven explicitly, so the page becomes seekable without any
 * authoring change: existing CSS-keyframe decks work untouched. This is
 * preferred over CDP virtual time, which is coarser and unreliable for
 * compositor-driven `transform` and `opacity` — exactly the properties slide
 * animations use most.
 *
 * The second departure from `export.ts` is structural. A deck is captured as
 * one continuous browsing session that advances page to page through the
 * viewer's own navigation, rather than as a series of independent page loads,
 * because that is the only way the viewer's transition animations exist at a
 * boundary to be seeked. A probe pass settles the deck's output shape before
 * any of that begins: a page gated by `<Steps>` cannot be crossed by a
 * continuous session without walking its reveals, and such a deck falls back to
 * the export path's shape of one independent load per page.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright-chromium';
import type { ViteDevServer } from 'vite';
import {
  atomicWriteFile,
  DEFAULT_TIMEOUT_MS,
  ExportUsageError,
  enumerateSlides,
  resolveExportTargets,
  startDevServer,
  tryImportPlaywright,
  zeroPageDeckIds,
} from './export.ts';

/** Flags accepted by `open-slide video`. Mirrors the Commander options in `run.ts`. */
export interface VideoFlags {
  slide?: string;
  all?: boolean;
  page?: number;
  out?: string;
  fps?: number;
  duration?: number;
  dwell?: number;
  port?: number;
  timeout?: number;
  keepFrames?: boolean;
  perPage?: boolean;
}

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_OUT_DIR = './video-export';

/**
 * Grace period after a page mounts or a boundary settles, before its animations
 * are measured.
 *
 * An animation registered a tick after mount would otherwise be missed by the
 * measurement and left out of the frame count, which shows up as a page whose
 * reported animation count is lower than the deck actually has.
 */
const MOUNT_SETTLE_MS = 250;

/**
 * Fallback page duration in milliseconds.
 *
 * Used when a page's animations are all infinite, or when it has none at all —
 * in either case there is no finite end to measure, and a still page still
 * needs to occupy time in the output.
 */
export const FALLBACK_DURATION_MS = 3_000;

/** Upper bound on a measured page duration, so one runaway delay cannot produce an hour of frames. */
export const MAX_DURATION_MS = 60_000;

/** Default hold after a page's animation completes, so a reader can absorb the settled state. */
export const DEFAULT_DWELL_MS = 1_500;

/**
 * Marker `settleTransition` stamps on a boundary animation it has driven to its
 * end, so the page measurement and the per-frame seek both skip it.
 *
 * The browser-side helpers are serialised into the page and cannot close over
 * module scope, so each of the three inlines this literal rather than reading
 * it. That duplication is guarded by a spec asserting their sources still carry
 * this exact value.
 */
export const SETTLED_ANIMATION_ID = 'osd-capture-settled';

/**
 * Marker `measureBoundary` stamps on the animations the viewer created at a page
 * boundary, so the per-frame seek can move the transition without also moving
 * the incoming page's content animations.
 *
 * Identifying a boundary animation costs a DOM walk from its target, and doing
 * that walk once per boundary rather than once per frame is why the tag exists.
 * It also keeps the target-based predicate in two places rather than three; see
 * `settleTransition`, which keeps its own copy because it must also catch an
 * animation that appeared after the measurement.
 *
 * `settleTransition` overwrites this with `SETTLED_ANIMATION_ID`, so a tag never
 * outlives the boundary that earned it.
 */
export const BOUNDARY_ANIMATION_ID = 'osd-capture-boundary';

/**
 * The four elements that turn a step-gated deck into one capturable as a single
 * file.
 *
 * Single sourced: the step-gated CLI warning composes its text from this
 * constant, and the slide-authoring skill's `references/loop-variant.md` states
 * the same four. Two independently maintained prose copies would drift, and the
 * warning's whole value is that it names what the skill then helps the author
 * build.
 */
export const LOOP_VARIANT_ELEMENTS = [
  'step reveals replaced by time-based animations',
  'transitions declared between pages',
  'pages that advance automatically instead of on input',
  "a closing transition into the first page's background, so the file plays as a seamless loop",
] as const;

/**
 * Which shape a deck's output takes.
 *
 * `whole-deck` is one MP4 covering every page; `per-page` is one MP4 per page,
 * reached either by `--per-page` or by the step-gated fallback. The two routes
 * resolve to this one value so there is a single capture, encode, and filename
 * derivation behind them.
 */
export type OutputShape = 'whole-deck' | 'per-page';

/**
 * A page's browser-measured timings, as handed to the planner.
 *
 * The planner measures nothing itself: both a page's animation length and a
 * boundary's are only knowable in the browser, so they arrive here already read
 * off `document.getAnimations()`.
 */
export interface MeasuredPage {
  /** Zero-based index of the page within its deck. */
  pageIndex: number;
  /** End time of the page's longest finite animation, or 0 when it has none. */
  longestMs: number;
  /**
   * End time of the longest animation the viewer created at the boundary into
   * the *next* page. Zero or omitted when the deck declares no transition, in
   * which case no transition segment is planned.
   */
  boundaryMs?: number;
}

/**
 * One contiguous run of frames in a deck's timeline.
 *
 * A `page` segment covers that page's animation followed by the run-wide dwell;
 * a `transition` segment covers the animations the viewer created at the
 * boundary leaving `pageIndex`, and never carries dwell.
 */
export interface TimelineSegment {
  kind: 'page' | 'transition';
  /** The page this segment renders, or for a transition the page it leaves. */
  pageIndex: number;
  /** Resolved animation length; the seek time is clamped to this during dwell. */
  durationMs: number;
  /** Hold appended after the animation. Always 0 for a transition. */
  dwellMs: number;
  /** Frames covering animation plus dwell. */
  frameCount: number;
}

/** Planner inputs that apply to the whole run rather than to one page. */
export interface TimelinePlanOptions {
  fps: number;
  /** Run-wide hold after each page's animation. Defaults to `DEFAULT_DWELL_MS`. */
  dwellMs?: number;
  /** `--duration`, replacing every page's measured value. Boundaries are unaffected. */
  durationOverrideMs?: number;
}

/**
 * Browser-side: pause every animation on the page and report the timeline
 * length that needs to be covered.
 *
 * Serialised and executed in the page by Playwright, so it must be
 * self-contained: no imports, no closure over module scope. Returns the end
 * time of the longest finite animation, which is what the frame count derives
 * from.
 *
 * Infinite animations are paused like any other and are still seeked, so a
 * looping pulse animates correctly in the output — they are only excluded from
 * the duration measurement, because they have no end to measure.
 */
export function pauseAndMeasure(): { count: number; longestMs: number } {
  let count = 0;
  let longest = 0;
  for (const animation of document.getAnimations()) {
    if (animation.id === 'osd-capture-settled') continue;
    animation.pause();
    count++;
    const timing = animation.effect?.getComputedTiming();
    if (!timing) continue;
    if (timing.iterations === Number.POSITIVE_INFINITY) continue;
    const delay = Number(timing.delay) || 0;
    const active = Number(timing.activeDuration) || 0;
    const endDelay = Number(timing.endDelay) || 0;
    longest = Math.max(longest, delay + active + endDelay);
  }
  return { count, longestMs: longest };
}

/**
 * Browser-side: measure the animations the viewer created at a page boundary,
 * and tag them so the seek can address them alone.
 *
 * The boundary's length is measured rather than read off `SlideTransition
 * .duration`, because `runPhase` resolves each phase as `phase.duration ??
 * duration` with its own `phase.delay`, and `resolveMorphTransition` gives morph
 * an independent duration and delay. A boundary sized from the declared value
 * truncates any deck that overrides either.
 *
 * Boundary animations are identified by target: the layer phases animate the
 * outgoing and incoming layer divs, which are direct children of the transition
 * wrapper, and morph animates clones inside the overlay. Page content sits
 * deeper than that, so it is never mistaken for a boundary.
 *
 * Animations already tagged `SETTLED_ANIMATION_ID` are skipped, or the previous
 * boundary's forwards-filled survivors would be measured as this one.
 *
 * @returns The boundary's animation count and the end time of its longest
 *   finite animation. Zero for a deck that declares no transition, which is what
 *   makes such a deck come out as pages alone.
 */
export function measureBoundary(): { count: number; longestMs: number } {
  const wrapper = document.querySelector('[data-osd-dir]');
  if (wrapper === null) return { count: 0, longestMs: 0 };
  let count = 0;
  let longest = 0;
  for (const animation of document.getAnimations()) {
    if (animation.id === 'osd-capture-settled') continue;
    const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
    if (target === null) continue;
    const isBoundary =
      target.parentElement === wrapper || target.closest('[data-osd-morph-layer]') !== null;
    if (!isBoundary) continue;
    animation.pause();
    animation.id = 'osd-capture-boundary';
    count++;
    const timing = animation.effect?.getComputedTiming();
    if (!timing) continue;
    if (timing.iterations === Number.POSITIVE_INFINITY) continue;
    const delay = Number(timing.delay) || 0;
    const active = Number(timing.activeDuration) || 0;
    const endDelay = Number(timing.endDelay) || 0;
    longest = Math.max(longest, delay + active + endDelay);
  }
  return { count, longestMs: longest };
}

/**
 * Browser-side: seek animations to the given time and wait for a paint.
 *
 * Setting `currentTime` on a paused animation invalidates style, but the commit
 * is not synchronous. Waiting two animation frames before resolving lets style
 * and layout settle so the screenshot that follows shows the seeked state
 * rather than the previous one.
 *
 * `boundaryOnly` narrows the seek to the animations `measureBoundary` tagged, so
 * a transition segment moves the transition alone. The incoming page's content
 * animations are mounted by then and stay held at zero, which is the state the
 * page segment that follows starts from; the outgoing page's stay where its
 * dwell left them.
 *
 * Animations `settleTransition` already drove to their end are left alone; see
 * `SETTLED_ANIMATION_ID` for why they are still here to be skipped.
 */
export function seekTo(input: { timeMs: number; boundaryOnly?: boolean }): Promise<void> {
  for (const animation of document.getAnimations()) {
    if (animation.id === 'osd-capture-settled') continue;
    if (input.boundaryOnly === true && animation.id !== 'osd-capture-boundary') continue;
    try {
      animation.currentTime = input.timeMs;
    } catch {
      /* An animation whose effect was removed mid-seek is not fatal; skip it. */
    }
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Browser-side: hold every animation at its start, from document start onward.
 *
 * Installed once as a context init script. The sweep repeats on an interval
 * rather than running once because an animation created after the first pass
 * would otherwise play out before it could be caught, and a played-out
 * animation leaves `document.getAnimations()` with nothing left to seek.
 *
 * The `playState` guard is load-bearing for determinism, not a micro
 * optimisation. `pause()` on an already-paused animation is a no-op to script,
 * but it re-commits the animation to the compositor, and a re-commit landing
 * between a seek and its screenshot re-rasters the layer. Without the guard the
 * interval fires that 250 times a second and a transition that animates
 * `transform` captures one of two stable rasterisations at random — two runs of
 * the same deck then differ across the boundary frames.
 */
export function pauseAllAnimations(): void {
  const pauseAll = () => {
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'paused') animation.pause();
    }
  };
  pauseAll();
  setInterval(pauseAll, 4);
  document.addEventListener('DOMContentLoaded', pauseAll);
}

/**
 * Browser-side: how many steps the mounted page gates content behind.
 *
 * `Step` renders `data-osd-step` unconditionally, so no automation hook has to
 * be added to the viewer for this. The query is document-wide, which is only
 * correct while a single page layer is mounted — during a transition both the
 * outgoing and incoming layers carry a `StepHost` and the count doubles. The
 * probe pass loads one page at a time, so that state never arises here.
 */
export function countStepElements(): number {
  return document.querySelectorAll('[data-osd-step]').length;
}

/**
 * Browser-side: drive a page boundary to completion, reporting whether it has
 * settled.
 *
 * `SlideTransitionLayer` unmounts the outgoing layer and restores morph-hidden
 * originals only from a `Promise.all(anims.map((a) => a.finished))` handler.
 * The capture's whole premise is that animations never finish, so left alone
 * that handler never runs and the outgoing page — and any morph overlay — stays
 * on screen for every remaining page of the deck.
 *
 * Only the boundary's own animations are finished. Those `measureBoundary`
 * already tagged are taken on the tag; the rest are identifiable by their
 * target, which is what catches one that appeared after the measurement — the
 * layer phases animate the outgoing and incoming layer divs,
 * which are direct children of the transition wrapper, and morph animates
 * clones inside the overlay. Page content animates elements deeper than that,
 * so finishing here can never cost a content animation its seekability.
 *
 * Settledness is read from the DOM rather than from the animation set, because
 * a finished animation with a forwards fill stays in `getAnimations()`. That
 * survivor is also why each one is tagged with `SETTLED_ANIMATION_ID`: the
 * incoming layer's enter animation outlives the boundary, and left untagged the
 * next page would measure its duration as page content and seek it back to
 * zero, replaying the transition underneath the page it just joined.
 *
 * @returns `true` once the wrapper holds a single layer and no overlay.
 */
export function settleTransition(): boolean {
  const wrapper = document.querySelector('[data-osd-dir]');
  if (wrapper === null) return true;
  for (const animation of document.getAnimations()) {
    let isBoundary = animation.id === 'osd-capture-boundary';
    if (!isBoundary) {
      const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
      if (target === null) continue;
      isBoundary =
        target.parentElement === wrapper || target.closest('[data-osd-morph-layer]') !== null;
    }
    if (!isBoundary) continue;
    /*
      Retagged before `finish()`, not after. A `finish()` that throws would
      otherwise leave the boundary tag in place, and `pauseAndMeasure` skips only
      the settled tag — the next page would then measure and seek a leftover
      transition animation as its own content, silently. The retag costs nothing
      on the retry path: this function is polled by `waitForFunction`, and the
      target test above re-identifies a settled-tagged boundary animation on
      every subsequent call.
    */
    try {
      animation.id = 'osd-capture-settled';
      animation.finish();
    } catch {
      /* An animation whose effect was removed mid-finish is not fatal; skip it. */
    }
  }
  return wrapper.childElementCount <= 1;
}

/**
 * Number of frames needed to cover a page.
 *
 * @param durationMs - Measured or overridden page duration.
 * @param fps - Frames per second.
 * @returns At least one frame, so a page with no animation still contributes a still.
 */
export function frameCountFor(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

/**
 * Clamp a measured animation length into the range worth rendering.
 *
 * @param longestMs - Longest finite animation end time, or 0 when there is none.
 * @param overrideMs - Explicit `--duration` in milliseconds, when supplied.
 */
export function resolveDurationMs(longestMs: number, overrideMs?: number): number {
  if (overrideMs !== undefined) return Math.min(overrideMs, MAX_DURATION_MS);
  if (longestMs <= 0) return FALLBACK_DURATION_MS;
  return Math.min(longestMs, MAX_DURATION_MS);
}

/**
 * Frames held after a segment's animation has run out.
 *
 * @param dwellMs - Run-wide dwell. Zero yields zero frames, unlike a page's
 *   animation which always contributes at least one.
 */
export function dwellFrameCountFor(dwellMs: number, fps: number): number {
  return Math.max(0, Math.round((dwellMs / 1000) * fps));
}

/**
 * Lay one measured page out as its animation followed by the run-wide dwell.
 *
 * Exported because a continuous session can only measure a page once it has
 * arrived there, so the capture plans a page at a time rather than a deck at a
 * time. `planDeckTimeline` composes the same helper, which is what keeps the two
 * from drifting.
 */
export function planPageSegment(page: MeasuredPage, options: TimelinePlanOptions): TimelineSegment {
  const { fps, dwellMs = DEFAULT_DWELL_MS, durationOverrideMs } = options;
  const durationMs = resolveDurationMs(page.longestMs, durationOverrideMs);
  return {
    kind: 'page',
    pageIndex: page.pageIndex,
    durationMs,
    dwellMs,
    frameCount: frameCountFor(durationMs, fps) + dwellFrameCountFor(dwellMs, fps),
  };
}

/**
 * Lay a measured page boundary out as its own segment.
 *
 * @param pageIndex - The page the boundary leaves.
 * @param boundaryMs - What the boundary's animations actually measured.
 * @returns `null` when nothing was measured, which is how a deck declaring no
 *   transition comes out as pages alone rather than with a synthesised join.
 */
export function planTransitionSegment(
  pageIndex: number,
  boundaryMs: number,
  fps: number,
): TimelineSegment | null {
  const durationMs = Math.min(boundaryMs, MAX_DURATION_MS);
  if (durationMs <= 0) return null;
  return {
    kind: 'transition',
    pageIndex,
    durationMs,
    dwellMs: 0,
    frameCount: frameCountFor(durationMs, fps),
  };
}

/**
 * Lay a deck out as an ordered list of seekable segments.
 *
 * Pure by construction: every duration arrives already measured in the browser
 * (a page's from its longest finite animation, a boundary's from the animations
 * the viewer actually created), so this only resolves, clamps, and counts.
 *
 * A boundary that measured zero produces no segment, which is how a deck
 * declaring no transition comes out as pages alone. The final page never gets a
 * boundary, since there is nothing to transition into.
 *
 * @param pages - Measured pages in capture order.
 * @param options - Frame rate, run-wide dwell, and the optional `--duration` override.
 * @returns Segments in playback order.
 */
export function planDeckTimeline(
  pages: readonly MeasuredPage[],
  options: TimelinePlanOptions,
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];

  pages.forEach((page, index) => {
    segments.push(planPageSegment(page, options));
    if (index === pages.length - 1) return;
    const transition = planTransitionSegment(page.pageIndex, page.boundaryMs ?? 0, options.fps);
    if (transition) segments.push(transition);
  });

  return segments;
}

/**
 * Seek time for one frame of a segment.
 *
 * Clamping to the segment's duration is what makes dwell a hold rather than an
 * overrun: every dwell frame seeks to the animation's end and so renders the
 * settled state.
 */
export function seekTimeMsFor(segment: TimelineSegment, frameIndex: number, fps: number): number {
  return Math.min((frameIndex / fps) * 1000, segment.durationMs);
}

/** Total frames a planned timeline writes, which is what the encode is sized by. */
export function totalFrameCount(segments: readonly TimelineSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.frameCount, 0);
}

/** One page's probe result: where it sits in the deck, and how many steps it gates. */
export interface ProbedPage {
  pageIndex: number;
  stepCount: number;
}

/**
 * Spread probe results across a deck-length array indexed by page.
 *
 * `stepGatedPages` and `stepGatedWarning` both read an index as a page number,
 * so a run that probes only part of a deck — `--page` selects one — must still
 * report positions in the deck rather than positions in the probed subset,
 * or the warning names the wrong pages. Unprobed pages count as ungated.
 *
 * @param totalPages - Pages in the deck, not in the selection.
 * @param probed - Probe results, in any order.
 */
export function stepCountsByPage(totalPages: number, probed: readonly ProbedPage[]): number[] {
  const counts = new Array<number>(totalPages).fill(0);
  for (const { pageIndex, stepCount } of probed) {
    if (pageIndex >= 0 && pageIndex < totalPages) counts[pageIndex] = stepCount;
  }
  return counts;
}

/**
 * Indices of the pages that gate content behind `<Steps>`.
 *
 * @param stepCounts - `[data-osd-step]` element count per page, in page order,
 *   read on arrival by the probe pass.
 * @returns Zero-based indices of the gated pages.
 */
export function stepGatedPages(stepCounts: readonly number[]): number[] {
  return stepCounts.flatMap((count, index) => (count > 0 ? [index] : []));
}

/**
 * Decide a deck's output shape.
 *
 * The fallback is per deck rather than per page: a single continuous session
 * cannot cross a step-gated page without walking its reveals, so one gated page
 * settles the shape for all of them.
 *
 * @param stepCounts - Step count per page, from the probe pass.
 * @param perPageRequested - Whether `--per-page` was passed.
 */
export function outputShapeFor(
  stepCounts: readonly number[],
  perPageRequested = false,
): OutputShape {
  if (perPageRequested) return 'per-page';
  return stepGatedPages(stepCounts).length > 0 ? 'per-page' : 'whole-deck';
}

/**
 * One deck's line in the closing summary.
 *
 * A mixed `--all` run produces both shapes, and the user only asked for one, so
 * the summary has to say which deck got which rather than leaving them to infer
 * it from the directory listing.
 *
 * @param fileCount - MP4s written for this deck.
 * @param stepGated - Whether the per-page shape was forced rather than requested.
 */
export function outputShapeSummary(
  slideId: string,
  shape: OutputShape,
  fileCount: number,
  stepGated = false,
): string {
  if (shape === 'whole-deck') return `${slideId} — 1 MP4 (whole deck)`;
  const reason = stepGated ? 'step-gated fallback' : '--per-page';
  return `${slideId} — ${fileCount} MP4(s) (per page, ${reason})`;
}

/**
 * The warning a step-gated deck earns, stating the shape change before its cause.
 *
 * The user asked for one file per deck and is getting N, so the message leads
 * with which pages forced that and why, then records what the fallback does and
 * does not cost, then names the route back to a single file. The loop-variant
 * elements are composed from `LOOP_VARIANT_ELEMENTS` rather than restated.
 *
 * @param slideId - Deck the warning is about.
 * @param gatedPageIndices - Zero-based indices from `stepGatedPages`.
 * @param totalPages - Pages in the deck, so the message can say "2 of 5".
 */
export function stepGatedWarning(
  slideId: string,
  gatedPageIndices: readonly number[],
  totalPages: number,
): string {
  const pageList = gatedPageIndices.map((index) => `p${index + 1}`).join(', ');
  return [
    `${slideId}: ${gatedPageIndices.length} of ${totalPages} page(s) are step-gated (${pageList}).`,
    `Wrote one MP4 per page rather than one for the deck, because a continuous capture cannot advance past a pending step without walking its reveals.`,
    `Each page is captured with every step already revealed, so no content is missing — but the reveal beats and the inter-page transitions are not in the output.`,
    `To get a single deck video, author a loop variant of this deck: ${LOOP_VARIANT_ELEMENTS.join('; ')}.`,
  ].join('\n');
}

/** Zero-padded frame filename, so lexical order matches temporal order for ffmpeg's globber. */
export function frameFilenameFor(index: number): string {
  return `frame-${String(index).padStart(6, '0')}.png`;
}

/**
 * Output filename for a captured video.
 *
 * One derivation serves both output shapes, so a file the step-gated fallback
 * wrote is indistinguishable from one `--per-page` wrote.
 *
 * @param slideId - Deck id.
 * @param page - Omit for the whole-deck shape; supply for the per-page shape.
 */
export function videoFilenameFor(
  slideId: string,
  page?: { pageIndex: number; total: number },
): string {
  if (!page) return `${slideId}.mp4`;
  const width = String(page.total).length;
  return `${slideId}-p${String(page.pageIndex + 1).padStart(width, '0')}.mp4`;
}

/** The bare-slide route the capture drives, shared with the PNG exporter. */
export function slideCaptureUrl(port: number, slideId: string, pageIndex: number): string {
  return `http://127.0.0.1:${port}/s/${slideId}?p=${pageIndex + 1}&export=png`;
}

/** A deck's share of a run: the pages selected from it, and how many it has in total. */
export interface DeckSelection {
  pageIndices: number[];
  total: number;
}

/**
 * Collapse the export module's flat `(slideId, pageIndex, total)` tuples into
 * per-deck selections.
 *
 * The output shape is a per-deck decision, so the run has to be walked deck by
 * deck rather than target by target. Insertion order is preserved so decks are
 * captured in enumeration order.
 */
export function groupTargetsByDeck(
  targets: readonly { slideId: string; pageIndex: number; total: number }[],
): Map<string, DeckSelection> {
  const decks = new Map<string, DeckSelection>();
  for (const target of targets) {
    const deck = decks.get(target.slideId) ?? { pageIndices: [], total: target.total };
    deck.pageIndices.push(target.pageIndex);
    decks.set(target.slideId, deck);
  }
  return decks;
}

/**
 * Wait for fonts, without waiting for animation.
 *
 * A frame captured mid font-swap renders in a fallback face. The PNG exporter's
 * readiness flag would cover this but cannot be used: it also waits for every
 * finite animation to finish, which is exactly what this capture prevents from
 * ever happening. A missing font degrades the frame; it does not invalidate the
 * run, so a timeout is reported and capture continues.
 *
 * This is a second font predicate, and knowingly the weaker one:
 * `app/lib/print-ready.ts`'s `waitForFonts` awaits `document.fonts.ready`, while
 * this polls `document.fonts.status`, which can read `loaded` before a face
 * requested later begins loading. The two are not merged because that one is
 * viewer-side and is reached through the readiness flag FR-21 forbids this
 * capture from gating on. The weaker predicate is acceptable here for the same
 * reason the timeout is swallowed: a degraded frame is not a failed run.
 */
async function waitForFonts(page: Page, label: string, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, {
      timeout: timeoutMs,
    });
  } catch {
    process.stderr.write(`${label} fonts not ready — capturing anyway\n`);
  }
}

/**
 * Measure the mounted page and lay it out as a single seekable segment.
 *
 * @returns The segment to capture and the animation count behind it, which
 *   FR-33's report line surfaces so a zero-animation capture is visible in the
 *   console rather than only in the output file.
 */
async function measureMountedPage(
  page: Page,
  pageIndex: number,
  options: TimelinePlanOptions,
): Promise<{ segment: TimelineSegment; animationCount: number }> {
  await page.waitForTimeout(MOUNT_SETTLE_MS);
  const measured = await page.evaluate(pauseAndMeasure);
  return {
    segment: planPageSegment({ pageIndex, longestMs: measured.longestMs }, options),
    animationCount: measured.count,
  };
}

/**
 * Seek and screenshot one segment into a frame sequence.
 *
 * @param startFrameIndex - Where this segment begins in the sequence, so a
 *   whole-deck capture numbers every page into one contiguous run that ffmpeg
 *   reads with a single glob.
 * @returns Frames written.
 */
async function writeSegmentFrames(
  page: Page,
  framesDir: string,
  startFrameIndex: number,
  segment: TimelineSegment,
  fps: number,
): Promise<number> {
  const boundaryOnly = segment.kind === 'transition';
  for (let i = 0; i < segment.frameCount; i++) {
    await page.evaluate(seekTo, { timeMs: seekTimeMsFor(segment, i, fps), boundaryOnly });
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    });
    await atomicWriteFile(path.join(framesDir, frameFilenameFor(startFrameIndex + i)), buffer);
  }
  return segment.frameCount;
}

function reportPage(
  slideId: string,
  pageIndex: number,
  animationCount: number,
  segment: TimelineSegment,
): void {
  process.stdout.write(
    `${slideId}:p${pageIndex + 1} — ${animationCount} animation(s), ${Math.round(segment.durationMs)}ms, ${segment.frameCount} frame(s)\n`,
  );
}

function reportBoundary(
  slideId: string,
  fromPageIndex: number,
  animationCount: number,
  segment: TimelineSegment | null,
): void {
  const captured = segment
    ? `${Math.round(segment.durationMs)}ms, ${segment.frameCount} frame(s)`
    : 'no transition declared';
  process.stdout.write(
    `${slideId}:p${fromPageIndex + 1}→p${fromPageIndex + 2} — ${animationCount} transition animation(s), ${captured}\n`,
  );
}

/**
 * Advance the deck one page in place, capturing the boundary as it goes.
 *
 * The advance goes through the viewer's own keyboard navigation rather than a
 * new `?p=` URL, because a reload destroys the outgoing layer and with it every
 * transition animation the boundary would be captured from. `Player`'s arrow
 * handler is not gated on its `controls` prop, so it is reachable in the bare
 * export view.
 *
 * Order here is load-bearing in both directions. The boundary is measured and
 * captured *before* it is settled, because settling tags its animations and a
 * tagged animation is skipped by every seek. It is settled *before* the next
 * page is measured, because the viewer unmounts the outgoing layer and restores
 * morph-hidden originals only once every transition animation resolves — a
 * boundary left paused strands both over every page that follows.
 *
 * @returns Frames written, which is zero for a deck that declares no transition.
 */
async function captureBoundary(
  page: Page,
  slideId: string,
  fromPageIndex: number,
  framesDir: string,
  startFrameIndex: number,
  fps: number,
  timeoutMs: number,
): Promise<number> {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(MOUNT_SETTLE_MS);

  const measured = await page.evaluate(measureBoundary);
  const segment = planTransitionSegment(fromPageIndex, measured.longestMs, fps);
  const frames = segment
    ? await writeSegmentFrames(page, framesDir, startFrameIndex, segment, fps)
    : 0;
  reportBoundary(slideId, fromPageIndex, measured.count, segment);

  await page.waitForFunction(settleTransition, undefined, { timeout: timeoutMs });
  return frames;
}

/**
 * Count the steps on every selected page of a deck, before any frame of it is
 * captured.
 *
 * Step-gating is a property of a page but the output shape is a property of a
 * deck, so a gate discovered on page three after two pages had been captured
 * into a continuous session would mean discarding that work. This settles the
 * question first. It captures no frames and no transitions, so it is cheap and
 * free to load pages independently — which is also what keeps the step count
 * honest, since only one page layer is ever mounted.
 *
 * @returns Step counts indexed by page within the deck, zero for pages outside
 *   the selection.
 */
export async function probeStepCounts(
  page: Page,
  port: number,
  slideId: string,
  selection: DeckSelection,
  timeoutMs: number,
): Promise<number[]> {
  const probed: ProbedPage[] = [];
  for (const pageIndex of selection.pageIndices) {
    await page.goto(slideCaptureUrl(port, slideId, pageIndex), { waitUntil: 'load' });
    await page.waitForSelector('[data-osd-canvas]', { timeout: timeoutMs }).catch(() => {});
    probed.push({ pageIndex, stepCount: await page.evaluate(countStepElements) });
  }
  return stepCountsByPage(selection.total, probed);
}

/** One file the capture will produce, and the frame sequence it will be encoded from. */
export interface CaptureUnit {
  /** How the unit is named on stdout: the deck, or the deck and page. */
  label: string;
  /** Directory holding this unit's numbered PNGs. */
  framesDir: string;
  /** Where the encode writes the MP4. */
  outFile: string;
  /** Frames written into `framesDir`. */
  frames: number;
}

/** Everything a deck's capture needs that is not the Playwright page itself. */
export interface DeckCaptureOptions {
  port: number;
  slideId: string;
  selection: DeckSelection;
  shape: OutputShape;
  outDir: string;
  fps: number;
  dwellMs: number;
  timeoutMs: number;
  durationOverrideMs?: number;
}

/**
 * Capture one page of a deck into an already-mounted document.
 *
 * The single measure-plan-seek-report step both output shapes are built from,
 * so `--per-page`, the step-gated fallback, and whole-deck capture cannot drift
 * in what a page's frames look like.
 *
 * @returns Frames written.
 */
async function capturePage(
  page: Page,
  slideId: string,
  pageIndex: number,
  framesDir: string,
  startFrameIndex: number,
  options: DeckCaptureOptions,
): Promise<number> {
  const { segment, animationCount } = await measureMountedPage(page, pageIndex, {
    fps: options.fps,
    dwellMs: options.dwellMs,
    durationOverrideMs: options.durationOverrideMs,
  });
  const frames = await writeSegmentFrames(page, framesDir, startFrameIndex, segment, options.fps);
  reportPage(slideId, pageIndex, animationCount, segment);
  return frames;
}

/**
 * Capture a deck as one continuous browsing session.
 *
 * One navigation, then the pages are reached by advancing the viewer rather than
 * by reloading, which is what makes the viewer's own transition animations exist
 * at each boundary to be seeked.
 */
async function captureWholeDeck(
  page: Page,
  options: DeckCaptureOptions,
): Promise<CaptureUnit | null> {
  const { port, slideId, selection, outDir, fps, timeoutMs } = options;
  const [firstPageIndex] = selection.pageIndices;
  if (firstPageIndex === undefined) return null;

  const framesDir = path.join(outDir, `.frames-${slideId}`);
  await fs.mkdir(framesDir, { recursive: true });
  await page.goto(slideCaptureUrl(port, slideId, firstPageIndex), { waitUntil: 'load' });
  await waitForFonts(page, `${slideId}:p${firstPageIndex + 1}`, timeoutMs);

  let written = 0;
  for (const [ordinal, pageIndex] of selection.pageIndices.entries()) {
    if (ordinal > 0) {
      const previousPageIndex = selection.pageIndices[ordinal - 1];
      written += await captureBoundary(
        page,
        slideId,
        previousPageIndex,
        framesDir,
        written,
        fps,
        timeoutMs,
      );
    }
    written += await capturePage(page, slideId, pageIndex, framesDir, written, options);
  }

  return {
    label: slideId,
    framesDir,
    outFile: path.join(outDir, videoFilenameFor(slideId)),
    frames: written,
  };
}

/**
 * Capture a deck as one independent page load per file.
 *
 * Reached both by `--per-page` and by the step-gated fallback, which is why they
 * are indistinguishable in the output. Loading fresh is why this shape has no
 * boundaries to capture, and also why a step-gated page is acceptable here: a
 * directly mounted page arrives with `entryDirection` at `jump`, and `Steps`
 * initialises to `stepCount` for any direction other than `forward`, so every
 * step is already revealed.
 */
async function capturePerPage(page: Page, options: DeckCaptureOptions): Promise<CaptureUnit[]> {
  const { port, slideId, selection, outDir, timeoutMs } = options;
  const units: CaptureUnit[] = [];

  for (const pageIndex of selection.pageIndices) {
    const framesDir = path.join(outDir, `.frames-${slideId}-p${pageIndex + 1}`);
    await fs.mkdir(framesDir, { recursive: true });
    await page.goto(slideCaptureUrl(port, slideId, pageIndex), { waitUntil: 'load' });
    await waitForFonts(page, `${slideId}:p${pageIndex + 1}`, timeoutMs);

    const frames = await capturePage(page, slideId, pageIndex, framesDir, 0, options);
    units.push({
      label: `${slideId}:p${pageIndex + 1}`,
      framesDir,
      outFile: path.join(outDir, videoFilenameFor(slideId, { pageIndex, total: selection.total })),
      frames,
    });
  }

  return units;
}

/**
 * Capture a deck into the frame sequences its resolved output shape calls for.
 *
 * The shape branch stops here: everything downstream — the encode, the frame
 * cleanup, the stdout line — reads the units this returns and never asks which
 * shape produced them.
 */
export async function captureDeck(page: Page, options: DeckCaptureOptions): Promise<CaptureUnit[]> {
  if (options.shape === 'per-page') return capturePerPage(page, options);
  const unit = await captureWholeDeck(page, options);
  return unit ? [unit] : [];
}

/**
 * Whether ffmpeg is callable from PATH.
 *
 * Preflighted alongside `playwright-chromium` rather than discovered at encode
 * time, because by then a deck's worth of frames has already been rendered and
 * the failure costs the whole run.
 */
export async function hasFfmpeg(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Encode a directory of numbered PNGs to H.264 MP4.
 *
 * `yuv420p` and the even-dimension scale filter are required for the result to
 * play in browsers and QuickTime rather than only in ffplay.
 *
 * The frames are read in order and concatenated. There is deliberately no
 * `-filter_complex` here: the page boundaries are already in the sequence as the
 * viewer's own animations, and composing a second transition at encode time
 * would define "transition" alongside the viewer's transition module.
 *
 * @throws When ffmpeg is missing from PATH or exits non-zero.
 */
export async function encodeFrames(framesDir: string, outFile: string, fps: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(fps),
        '-i',
        path.join(framesDir, 'frame-%06d.png'),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        outFile,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', (err) => {
      reject(
        new ExportUsageError(
          `ffmpeg could not be started (${err.message}). Install ffmpeg and ensure it is on PATH.`,
        ),
      );
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Reject flag combinations the capture cannot honour.
 *
 * @throws {ExportUsageError} On mutually exclusive selection, `--page` without
 *   a deck, no selection at all, or an out-of-range frame rate.
 */
export function validateFlags(flags: VideoFlags): void {
  if (flags.slide && flags.all) {
    throw new ExportUsageError('--slide and --all are mutually exclusive');
  }
  if (flags.page !== undefined && !flags.slide) {
    throw new ExportUsageError('--page requires --slide');
  }
  if (!flags.slide && !flags.all) {
    throw new ExportUsageError('one of --slide or --all is required');
  }
  if (flags.fps !== undefined && (flags.fps < 1 || flags.fps > 120)) {
    throw new ExportUsageError('--fps must be between 1 and 120');
  }
}

/**
 * Entry point invoked by `run.ts` after Commander parses the flags.
 *
 * Tears the browser and dev server down on every exit path, matching the PNG
 * exporter: a leaked Chromium hangs CI until the job times out.
 */
export async function videoCommand(flags: VideoFlags = {}): Promise<void> {
  try {
    validateFlags(flags);
  } catch (err) {
    if (err instanceof ExportUsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const playwright = await tryImportPlaywright();
  if (playwright === null) {
    process.stderr.write(
      [
        '`open-slide video` needs playwright-chromium, which is not installed in this workspace.',
        '',
        '  pnpm add -D playwright-chromium',
        '  npx playwright install chromium',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  if (!(await hasFfmpeg())) {
    process.stderr.write(
      [
        '`open-slide video` needs ffmpeg, which was not found on PATH.',
        '',
        '  macOS:   brew install ffmpeg',
        '  Debian:  sudo apt install ffmpeg',
        '  Windows: winget install Gyan.FFmpeg',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  const outDir = path.resolve(process.cwd(), flags.out ?? DEFAULT_OUT_DIR);
  const fps = flags.fps ?? DEFAULT_FPS;
  const dwellMs = flags.dwell ?? DEFAULT_DWELL_MS;
  const timeoutMs = flags.timeout ?? DEFAULT_TIMEOUT_MS;

  await fs.mkdir(outDir, { recursive: true });

  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    const started = await startDevServer({ port: flags.port });
    server = started.server;
    const slides = await enumerateSlides(started.port);
    const targets = resolveExportTargets(flags, slides);

    for (const id of zeroPageDeckIds(flags, slides)) {
      process.stderr.write(
        `${id}: 0 pages — skipped (deck is empty, or its default export could not be parsed)\n`,
      );
    }

    browser = await playwright.chromium.launch();
    /*
      `Player` passes `disabled={prefersReducedMotion}` to the transition layer,
      and the disabled branch swaps pages with no animation at all — so a
      capture run under a `reduce` preference yields a valid file with no
      transitions and no error anywhere.
    */
    const context = await browser.newContext({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    });
    await context.addInitScript(pauseAllAnimations);
    const page = await context.newPage();

    const summaries: string[] = [];
    for (const [slideId, selection] of groupTargetsByDeck(targets)) {
      const stepCounts = await probeStepCounts(page, started.port, slideId, selection, timeoutMs);
      const gated = stepGatedPages(stepCounts);
      const shape = outputShapeFor(stepCounts, flags.perPage);
      const forcedByGating = shape === 'per-page' && gated.length > 0 && !flags.perPage;

      /* A successful outcome, not a failure: the run continues and exits 0. */
      if (forcedByGating) {
        process.stderr.write(`${stepGatedWarning(slideId, gated, selection.total)}\n`);
      }

      const units = await captureDeck(page, {
        port: started.port,
        slideId,
        selection,
        shape,
        outDir,
        fps,
        dwellMs,
        timeoutMs,
        durationOverrideMs: flags.duration,
      });

      for (const unit of units) {
        await encodeFrames(unit.framesDir, unit.outFile, fps);
        if (!flags.keepFrames) await fs.rm(unit.framesDir, { recursive: true, force: true });
        process.stdout.write(
          `${unit.label} → ${path.relative(process.cwd(), unit.outFile) || unit.outFile} (${unit.frames} frames @ ${fps}fps)\n`,
        );
      }

      summaries.push(outputShapeSummary(slideId, shape, units.length, forcedByGating));
    }

    const deckCount = new Set(targets.map((t) => t.slideId)).size;
    process.stdout.write(
      `Rendered ${targets.length} page(s) from ${deckCount} deck(s) to ${path.relative(process.cwd(), outDir) || outDir}\n`,
    );
    for (const summary of summaries) process.stdout.write(`  ${summary}\n`);
  } catch (err) {
    if (err instanceof ExportUsageError) {
      process.stderr.write(`${err.message}\n`);
      await closeAll(browser, server);
      process.exit(2);
    }
    process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
    await closeAll(browser, server);
    process.exit(1);
  } finally {
    await closeAll(browser, server);
  }
}

async function closeAll(browser: Browser | null, server: ViteDevServer | null): Promise<void> {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
