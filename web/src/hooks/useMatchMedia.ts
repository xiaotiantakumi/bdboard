import { useEffect, useState } from 'react';
import { canUseMatchMedia, matchesMediaQuery } from '../mediaQueries';

/**
 * Subscribes to a window.matchMedia query. Returns false when matchMedia is
 * unavailable (SSR / test environments without a stub).
 */
export function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesMediaQuery(query));

  useEffect(() => {
    if (!canUseMatchMedia()) {
      return;
    }
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };
    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
