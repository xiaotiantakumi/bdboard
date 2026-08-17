import { useEffect } from 'react';
import { updateAppBadge } from '../appBadge';

export function useAppBadge(count: number | undefined): void {
  useEffect(() => {
    updateAppBadge(count ?? 0);
  }, [count]);
}
