import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchPrLinks, type PrBadgeDto } from '../api';

/**
 * bdboard-62p4 PR-3: App.tsx の `pr-links` クエリと、そこから導く prLinksById を
 * 集約した。(hygiene クエリの invalidate は bdboard-i9g4.6 で健全性ビューと共に撤去。)
 */
export function usePrLinksData(
  selectedProjectIds: string[],
  selectedProjectIdsJoined: string,
) {
  const prLinksQuery = useQuery({
    queryKey: ['pr-links', selectedProjectIdsJoined],
    queryFn: () => fetchPrLinks(selectedProjectIds),
    retry: false,
  });

  const prLinksById = useMemo(() => {
    const map = new Map<string, PrBadgeDto>();
    for (const badge of prLinksQuery.data ?? []) {
      map.set(badge.ticketId, badge);
    }
    return map;
  }, [prLinksQuery.data]);

  return { prLinksQuery, prLinksById };
}
