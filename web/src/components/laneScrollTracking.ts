import type { Lane } from '../api';

export function laneFromElement(element: Element): Lane | null {
  const lane = element.getAttribute('data-lane');
  if (lane === null || lane === '') {
    return null;
  }
  return lane as Lane;
}

/**
 * Picks the lane whose column occupies the largest visible share of the scroll
 * container. Tie-break toward earlier lanes in laneOrder (left wins).
 */
export function selectMostVisibleLane(
  entries: readonly IntersectionObserverEntry[],
  laneOrder: readonly Lane[],
): Lane | null {
  let bestLane: Lane | null = null;
  let bestRatio = -1;
  let bestIndex = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    if (!entry.isIntersecting && entry.intersectionRatio <= 0) {
      continue;
    }
    const lane = laneFromElement(entry.target);
    if (lane === null) {
      continue;
    }
    const index = laneOrder.indexOf(lane);
    if (index < 0) {
      continue;
    }
    const ratio = entry.intersectionRatio;
    if (
      ratio > bestRatio ||
      (ratio === bestRatio && index < bestIndex)
    ) {
      bestLane = lane;
      bestRatio = ratio;
      bestIndex = index;
    }
  }

  return bestLane;
}
