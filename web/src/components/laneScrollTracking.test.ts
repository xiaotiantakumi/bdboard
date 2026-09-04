import { describe, expect, it } from 'vitest';
import { selectMostVisibleLane } from './laneScrollTracking';
import type { Lane } from '../api';

function makeIntersectionObserverEntry(
  target: Element,
  intersectionRatio: number,
  isIntersecting = intersectionRatio > 0,
): IntersectionObserverEntry {
  const rect = new DOMRect(0, 0, 100, 100);
  return {
    boundingClientRect: rect,
    intersectionRatio,
    intersectionRect: rect,
    isIntersecting,
    rootBounds: null,
    target,
    time: 0,
  };
}

function entry(
  lane: Lane,
  intersectionRatio: number,
  isIntersecting = intersectionRatio > 0,
): IntersectionObserverEntry {
  const target = document.createElement('section');
  target.setAttribute('data-lane', lane);
  return makeIntersectionObserverEntry(target, intersectionRatio, isIntersecting);
}

describe('selectMostVisibleLane', () => {
  const laneOrder = [
    'ready',
    'in_progress',
    'awaiting_human',
    'blocked',
    'done',
  ] as const satisfies readonly Lane[];

  it('returns the lane with the highest intersection ratio', () => {
    expect(
      selectMostVisibleLane(
        [entry('ready', 0.2), entry('in_progress', 0.8)],
        laneOrder,
      ),
    ).toBe('in_progress');
  });

  it('breaks ties toward the earlier lane in lane order', () => {
    expect(
      selectMostVisibleLane(
        [entry('ready', 0.6), entry('in_progress', 0.6)],
        laneOrder,
      ),
    ).toBe('ready');
  });

  it('ignores elements without data-lane', () => {
    const orphan = document.createElement('div');
    expect(
      selectMostVisibleLane(
        [
          makeIntersectionObserverEntry(orphan, 1, true),
          entry('blocked', 0.4),
        ],
        laneOrder,
      ),
    ).toBe('blocked');
  });

  it('returns null when nothing is intersecting', () => {
    expect(
      selectMostVisibleLane(
        [entry('ready', 0, false), entry('done', 0, false)],
        laneOrder,
      ),
    ).toBeNull();
  });
});
