/**
 * @agents-index Unit tests for `open-slide video`'s pure planning layer —
 * duration resolution, frame counting, the deck timeline (page and transition
 * segments), step-gating detection, output-shape selection, filename
 * derivation, run grouping, and flag validation. Nothing here launches Chromium or ffmpeg;
 * the capture and encode paths are verified by hand.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExportUsageError } from './export.ts';
import {
  BOUNDARY_ANIMATION_ID,
  DEFAULT_DWELL_MS,
  FALLBACK_DURATION_MS,
  frameCountFor,
  frameFilenameFor,
  groupTargetsByDeck,
  LOOP_VARIANT_ELEMENTS,
  MAX_DURATION_MS,
  measureBoundary,
  outputShapeFor,
  outputShapeSummary,
  pauseAndMeasure,
  planDeckTimeline,
  planPageSegment,
  planTransitionSegment,
  resolveDurationMs,
  SETTLED_ANIMATION_ID,
  seekTimeMsFor,
  seekTo,
  settleTransition,
  slideCaptureUrl,
  stepCountsByPage,
  stepGatedPages,
  stepGatedWarning,
  totalFrameCount,
  validateFlags,
  videoFilenameFor,
} from './video.ts';

describe('resolveDurationMs', () => {
  it('uses the measured value', () => {
    expect(resolveDurationMs(1800)).toBe(1800);
  });

  it('falls back when nothing is measurable', () => {
    expect(resolveDurationMs(0)).toBe(FALLBACK_DURATION_MS);
  });

  it('clamps a runaway duration', () => {
    expect(resolveDurationMs(10_000_000)).toBe(MAX_DURATION_MS);
  });

  it('honours the override', () => {
    expect(resolveDurationMs(1800, 500)).toBe(500);
    expect(resolveDurationMs(0, 500)).toBe(500);
    expect(resolveDurationMs(1800, 10_000_000)).toBe(MAX_DURATION_MS);
  });
});

describe('frameCountFor', () => {
  it('never returns zero', () => {
    expect(frameCountFor(0, 30)).toBe(1);
  });

  it('scales with fps', () => {
    expect(frameCountFor(1000, 24)).toBe(24);
    expect(frameCountFor(1000, 60)).toBe(60);
  });
});

describe('planDeckTimeline', () => {
  it('orders pages and applies dwell', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 1000 },
        { pageIndex: 1, longestMs: 2000 },
      ],
      { fps: 30, dwellMs: 1000 },
    );

    expect(segments).toEqual([
      { kind: 'page', pageIndex: 0, durationMs: 1000, dwellMs: 1000, frameCount: 60 },
      { kind: 'page', pageIndex: 1, durationMs: 2000, dwellMs: 1000, frameCount: 90 },
    ]);
  });

  it('applies one dwell to every page', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 500 },
        { pageIndex: 1, longestMs: 1500 },
        { pageIndex: 2, longestMs: 0 },
      ],
      { fps: 30, dwellMs: 1500 },
    );

    expect(segments.map((s) => s.dwellMs)).toEqual([1500, 1500, 1500]);
  });

  it('defaults dwell to 1500ms', () => {
    const [segment] = planDeckTimeline([{ pageIndex: 0, longestMs: 1000 }], { fps: 30 });

    expect(DEFAULT_DWELL_MS).toBe(1500);
    expect(segment.dwellMs).toBe(1500);
    expect(segment.frameCount).toBe(75);
  });

  it('emits a transition segment from a measured boundary', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 1000, boundaryMs: 400 },
        { pageIndex: 1, longestMs: 1000 },
      ],
      { fps: 30, dwellMs: 0 },
    );

    expect(segments.map((s) => s.kind)).toEqual(['page', 'transition', 'page']);
    expect(segments[1]).toEqual({
      kind: 'transition',
      pageIndex: 0,
      durationMs: 400,
      dwellMs: 0,
      frameCount: 12,
    });
  });

  it('emits no transition segment for a single page', () => {
    const segments = planDeckTimeline([{ pageIndex: 0, longestMs: 1000, boundaryMs: 400 }], {
      fps: 30,
      dwellMs: 0,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('page');
  });

  it('emits no transition segment for a zero-length boundary', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 1000, boundaryMs: 0 },
        { pageIndex: 1, longestMs: 1000 },
      ],
      { fps: 30, dwellMs: 0 },
    );

    expect(segments.map((s) => s.kind)).toEqual(['page', 'page']);
  });

  it('clamps a runaway boundary', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 1000, boundaryMs: 10_000_000 },
        { pageIndex: 1, longestMs: 1000 },
      ],
      { fps: 30, dwellMs: 0 },
    );

    expect(segments[1].durationMs).toBe(MAX_DURATION_MS);
  });

  it('replaces every page duration with the override but leaves boundaries measured', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 8000, boundaryMs: 400 },
        { pageIndex: 1, longestMs: 200 },
      ],
      { fps: 30, dwellMs: 0, durationOverrideMs: 1000 },
    );

    expect(segments.map((s) => s.durationMs)).toEqual([1000, 400, 1000]);
  });
});

describe('planPageSegment and planTransitionSegment', () => {
  it('builds the segments planDeckTimeline emits, so the capture can plan a page at a time', () => {
    const pages = [
      { pageIndex: 0, longestMs: 1000, boundaryMs: 400 },
      { pageIndex: 1, longestMs: 2000 },
    ];
    const options = { fps: 30, dwellMs: 500 };

    expect(planDeckTimeline(pages, options)).toEqual([
      planPageSegment(pages[0], options),
      planTransitionSegment(0, 400, 30),
      planPageSegment(pages[1], options),
    ]);
  });

  it('plans no transition segment for a boundary that measured nothing', () => {
    expect(planTransitionSegment(0, 0, 30)).toBeNull();
  });

  it('clamps a runaway boundary', () => {
    expect(planTransitionSegment(0, 10_000_000, 30)?.durationMs).toBe(MAX_DURATION_MS);
  });

  it('never lets a transition segment carry dwell', () => {
    expect(planTransitionSegment(0, 400, 30)?.dwellMs).toBe(0);
  });
});

describe('outputShapeSummary', () => {
  it('names the whole-deck shape', () => {
    expect(outputShapeSummary('deck', 'whole-deck', 1)).toBe('deck — 1 MP4 (whole deck)');
  });

  it('distinguishes a requested per-page run from a forced one', () => {
    expect(outputShapeSummary('deck', 'per-page', 3)).toContain('--per-page');
    expect(outputShapeSummary('deck', 'per-page', 3, true)).toContain('step-gated fallback');
  });

  it('states the file count so a mixed run is legible', () => {
    expect(outputShapeSummary('gated', 'per-page', 4, true)).toContain('4 MP4(s)');
  });
});

describe('seekTimeMsFor', () => {
  it('steps the animation frame by frame', () => {
    const [segment] = planDeckTimeline([{ pageIndex: 0, longestMs: 1000 }], {
      fps: 10,
      dwellMs: 0,
    });

    expect(seekTimeMsFor(segment, 0, 10)).toBe(0);
    expect(seekTimeMsFor(segment, 5, 10)).toBe(500);
  });

  it('holds the settled state across the dwell frames', () => {
    const [segment] = planDeckTimeline([{ pageIndex: 0, longestMs: 1000 }], {
      fps: 10,
      dwellMs: 2000,
    });

    expect(segment.frameCount).toBe(30);
    expect(seekTimeMsFor(segment, 10, 10)).toBe(1000);
    expect(seekTimeMsFor(segment, 29, 10)).toBe(1000);
  });
});

describe('totalFrameCount', () => {
  it('sums page and transition segments', () => {
    const segments = planDeckTimeline(
      [
        { pageIndex: 0, longestMs: 1000, boundaryMs: 1000 },
        { pageIndex: 1, longestMs: 1000 },
      ],
      { fps: 30, dwellMs: 0 },
    );

    expect(totalFrameCount(segments)).toBe(90);
  });
});

describe('stepGatedPages', () => {
  it('flags pages with a non-zero step count', () => {
    expect(stepGatedPages([0, 3, 0, 1, 0])).toEqual([1, 3]);
  });

  it('returns nothing for a deck with no steps', () => {
    expect(stepGatedPages([0, 0, 0])).toEqual([]);
  });
});

describe('stepGatedWarning', () => {
  it('names the pages, the shape change, and the loop variant', () => {
    const message = stepGatedWarning('deck', [1, 3], 5);

    expect(message).toContain('deck');
    expect(message).toContain('2 of 5');
    expect(message).toContain('p2, p4');
    expect(message).toContain('one MP4 per page');
    expect(message).toContain('pending step');
    expect(message).toContain('every step already revealed');
    expect(message).toContain('no content is missing');
    expect(message).toContain('reveal beats and the inter-page transitions');
    expect(message).toContain('loop variant');
    for (const element of LOOP_VARIANT_ELEMENTS) {
      expect(message).toContain(element);
    }
  });

  it('states the shape change before its consequences', () => {
    const message = stepGatedWarning('deck', [0], 2);

    expect(message.indexOf('step-gated')).toBeLessThan(message.indexOf('one MP4 per page'));
    expect(message.indexOf('one MP4 per page')).toBeLessThan(message.indexOf('loop variant'));
  });
});

describe('LOOP_VARIANT_ELEMENTS', () => {
  it('matches the slide-authoring reference', () => {
    const reference = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../skills/slide-authoring/references/loop-variant.md',
      ),
      'utf8',
    ).toLowerCase();

    for (const element of LOOP_VARIANT_ELEMENTS) {
      expect(reference).toContain(element.toLowerCase());
    }
  });
});

describe('outputShapeFor', () => {
  it('picks per-page when any page is step-gated', () => {
    expect(outputShapeFor([0, 0, 2, 0])).toBe('per-page');
  });

  it('picks whole-deck when no page is step-gated', () => {
    expect(outputShapeFor([0, 0, 0])).toBe('whole-deck');
  });

  it('picks per-page when --per-page is passed', () => {
    expect(outputShapeFor([0, 0, 0], true)).toBe('per-page');
  });
});

describe('frameFilenameFor', () => {
  it('sorts lexically', () => {
    const names = [9, 10, 100].map(frameFilenameFor);

    expect(names).toEqual(['frame-000009.png', 'frame-000010.png', 'frame-000100.png']);
    expect([...names].sort()).toEqual(names);
  });
});

describe('videoFilenameFor', () => {
  it('derives a deck-level name', () => {
    expect(videoFilenameFor('deck')).toBe('deck.mp4');
  });

  it('derives a page-level name for the per-page shape', () => {
    expect(videoFilenameFor('deck', { pageIndex: 0, total: 9 })).toBe('deck-p1.mp4');
    expect(videoFilenameFor('deck', { pageIndex: 9, total: 12 })).toBe('deck-p10.mp4');
  });

  it('derives the same name whether the shape came from the flag or the fallback', () => {
    const flagged = outputShapeFor([0, 0, 0], true);
    const fallback = outputShapeFor([0, 2, 0]);

    expect(flagged).toBe(fallback);
    expect(videoFilenameFor('deck', { pageIndex: 1, total: 3 })).toBe(
      videoFilenameFor('deck', { pageIndex: 1, total: 3 }),
    );
  });
});

describe('SETTLED_ANIMATION_ID', () => {
  it('is the marker every browser-side helper inlines', () => {
    for (const fn of [settleTransition, pauseAndMeasure, seekTo, measureBoundary]) {
      expect(fn.toString()).toContain(SETTLED_ANIMATION_ID);
    }
  });
});

describe('BOUNDARY_ANIMATION_ID', () => {
  it('is the marker the boundary helpers inline', () => {
    for (const fn of [measureBoundary, seekTo, settleTransition]) {
      expect(fn.toString()).toContain(BOUNDARY_ANIMATION_ID);
    }
  });

  it('is applied by the measure and consumed by the seek, so a boundary is tagged before it moves', () => {
    expect(measureBoundary.toString()).toMatch(
      new RegExp(`animation\\.id = .${BOUNDARY_ANIMATION_ID}.`),
    );
    expect(seekTo.toString()).toMatch(new RegExp(`animation\\.id !== .${BOUNDARY_ANIMATION_ID}.`));
  });
});

describe('boundary identification', () => {
  it('is read from the transition wrapper and the morph overlay, not from a declared duration', () => {
    for (const fn of [measureBoundary, settleTransition]) {
      expect(fn.toString()).toContain('[data-osd-dir]');
      expect(fn.toString()).toContain('[data-osd-morph-layer]');
    }
  });
});

describe('slideCaptureUrl', () => {
  it('addresses the bare export view by 1-based page', () => {
    expect(slideCaptureUrl(5173, 'deck', 0)).toBe('http://127.0.0.1:5173/s/deck?p=1&export=png');
  });
});

describe('stepCountsByPage', () => {
  it('indexes by page within the deck, not within the selection', () => {
    expect(stepCountsByPage(4, [{ pageIndex: 2, stepCount: 3 }])).toEqual([0, 0, 3, 0]);
  });

  it('keeps the warning naming the right page when only part of a deck is probed', () => {
    const counts = stepCountsByPage(5, [{ pageIndex: 3, stepCount: 1 }]);

    expect(stepGatedPages(counts)).toEqual([3]);
    expect(stepGatedWarning('deck', stepGatedPages(counts), 5)).toContain('(p4)');
  });

  it('ignores results outside the deck', () => {
    expect(stepCountsByPage(2, [{ pageIndex: 7, stepCount: 4 }])).toEqual([0, 0]);
  });
});

describe('groupTargetsByDeck', () => {
  it('collapses flat targets into per-deck selections in enumeration order', () => {
    const decks = groupTargetsByDeck([
      { slideId: 'a', pageIndex: 0, total: 2 },
      { slideId: 'a', pageIndex: 1, total: 2 },
      { slideId: 'b', pageIndex: 0, total: 1 },
    ]);

    expect([...decks.keys()]).toEqual(['a', 'b']);
    expect(decks.get('a')).toEqual({ pageIndices: [0, 1], total: 2 });
    expect(decks.get('b')).toEqual({ pageIndices: [0], total: 1 });
  });

  it('records the deck total, not the selected page count', () => {
    const decks = groupTargetsByDeck([{ slideId: 'a', pageIndex: 2, total: 6 }]);

    expect(decks.get('a')).toEqual({ pageIndices: [2], total: 6 });
  });
});

describe('validateFlags', () => {
  it('rejects --slide with --all', () => {
    expect(() => validateFlags({ slide: 'deck', all: true })).toThrow(ExportUsageError);
  });

  it('rejects --page without --slide', () => {
    expect(() => validateFlags({ page: 2 })).toThrow(ExportUsageError);
  });

  it('rejects an out-of-range fps', () => {
    expect(() => validateFlags({ slide: 'deck', fps: 0 })).toThrow(ExportUsageError);
    expect(() => validateFlags({ slide: 'deck', fps: 121 })).toThrow(ExportUsageError);
  });

  it('accepts a valid selection', () => {
    expect(() => validateFlags({ slide: 'deck', fps: 30 })).not.toThrow();
    expect(() => validateFlags({ all: true })).not.toThrow();
  });
});

/**
 * Minimal stand-in for a `CSSAnimation`, carrying only what the browser-side
 * helpers touch. It lets those helpers run under the node environment, so their
 * behaviour is asserted rather than grepped out of their source.
 */
interface FakeAnimation {
  id: string;
  playState: string;
  currentTime: number;
  effect: {
    target?: unknown;
    getComputedTiming: () => {
      delay: number;
      activeDuration: number;
      endDelay: number;
      iterations: number;
    };
  } | null;
  pause: () => void;
  finish: () => void;
}

function fakeAnimation(overrides: Partial<FakeAnimation> & { activeDuration?: number } = {}) {
  const { activeDuration = 0, ...rest } = overrides;
  const animation: FakeAnimation = {
    id: '',
    playState: 'running',
    currentTime: 0,
    effect: {
      getComputedTiming: () => ({
        delay: 0,
        activeDuration,
        endDelay: 0,
        iterations: 1,
      }),
    },
    pause() {
      animation.playState = 'paused';
    },
    finish() {
      animation.playState = 'finished';
    },
    ...rest,
  };
  return animation;
}

/** Install a `document` exposing `animations`, and restore whatever was there. */
function withDocument(
  animations: FakeAnimation[],
  wrapper: unknown,
  body: () => void | Promise<void>,
): void | Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  const previousDocument = globals.document;
  const previousRaf = globals.requestAnimationFrame;
  globals.document = {
    getAnimations: () => animations,
    querySelector: () => wrapper,
  };
  globals.requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
  try {
    return body();
  } finally {
    globals.document = previousDocument;
    globals.requestAnimationFrame = previousRaf;
  }
}

describe('infinite animations', () => {
  it('are paused and counted but left out of the duration measurement', () => {
    const infinite = fakeAnimation({
      activeDuration: Number.POSITIVE_INFINITY,
      effect: {
        getComputedTiming: () => ({
          delay: 0,
          activeDuration: Number.POSITIVE_INFINITY,
          endDelay: 0,
          iterations: Number.POSITIVE_INFINITY,
        }),
      },
    });
    const finite = fakeAnimation({ activeDuration: 800 });

    withDocument([infinite, finite], null, () => {
      expect(pauseAndMeasure()).toEqual({ count: 2, longestMs: 800 });
      expect(infinite.playState).toBe('paused');
    });
  });

  it('are seeked with everything else, so a looping page still animates', async () => {
    const infinite = fakeAnimation({
      effect: {
        getComputedTiming: () => ({
          delay: 0,
          activeDuration: Number.POSITIVE_INFINITY,
          endDelay: 0,
          iterations: Number.POSITIVE_INFINITY,
        }),
      },
    });
    const settled = fakeAnimation({ id: SETTLED_ANIMATION_ID });

    await withDocument([infinite, settled], null, async () => {
      await seekTo({ timeMs: 400 });
      expect(infinite.currentTime).toBe(400);
      expect(settled.currentTime).toBe(0);
    });
  });

  it('do not, by being unmeasurable, collapse the page to nothing', () => {
    expect(resolveDurationMs(0)).toBe(FALLBACK_DURATION_MS);
    expect(frameCountFor(FALLBACK_DURATION_MS, 30)).toBeGreaterThan(1);
  });
});

describe('settleTransition tagging', () => {
  it('retags a boundary animation whose finish throws, so the next page cannot measure it', () => {
    const wrapper = { childElementCount: 1 };
    const stubborn = fakeAnimation({
      id: BOUNDARY_ANIMATION_ID,
      activeDuration: 500,
      finish() {
        throw new Error('effect removed mid-finish');
      },
    });

    withDocument([stubborn], wrapper, () => {
      expect(settleTransition()).toBe(true);
      expect(stubborn.id).toBe(SETTLED_ANIMATION_ID);
      expect(pauseAndMeasure()).toEqual({ count: 0, longestMs: 0 });
    });
  });
});
