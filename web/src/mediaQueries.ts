/**
 * Media query strings shared with index.css, plus read-once matchMedia helpers.
 * mediaQueries.test.ts checks that each constant has a matching @media block in index.css.
 */

/**
 * Matches index.css @media (max-width: 700px).
 * Keep this paired with the CSS breakpoint: changing only one makes JS and CSS
 * disagree about the layout breakpoint.
 */
export const MOBILE_LAYOUT_MEDIA_QUERY = '(max-width: 700px)';

/**
 * Matches index.css @media (prefers-reduced-motion: reduce).
 * Keep this paired with the CSS block: changing only one makes JS-driven motion
 * (e.g. scrollIntoView behavior) and CSS transitions disagree about reduced motion.
 */
export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

/** False in SSR and in test environments without a window.matchMedia stub. */
export function canUseMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * Reads a media query once (e.g. inside an event handler). Returns false when
 * matchMedia is unavailable. To re-render on changes, use the useMatchMedia hook instead.
 */
export function matchesMediaQuery(query: string): boolean {
  return canUseMatchMedia() && window.matchMedia(query).matches;
}
