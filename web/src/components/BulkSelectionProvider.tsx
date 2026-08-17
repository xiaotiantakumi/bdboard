import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** orderedIds 上の fromId〜toId（両端含む）の ID を返す */
export function idsInInclusiveRange(
  orderedIds: readonly string[],
  fromId: string,
  toId: string,
): string[] {
  const fromIndex = orderedIds.indexOf(fromId);
  const toIndex = orderedIds.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1) {
    return [];
  }
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return orderedIds.slice(start, end + 1);
}

export interface BulkSelectionContextValue {
  selectedIds: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  /** orderedIds の並びに沿って fromId〜toId を選択に追加する */
  selectRange: (
    orderedIds: readonly string[],
    fromId: string,
    toId: string,
  ) => void;
  deselectAll: (ids: readonly string[]) => void;
  clear: () => void;
}

const BulkSelectionContext = createContext<BulkSelectionContextValue | null>(
  null,
);

export function BulkSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  const toggle = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectRange = useCallback(
    (orderedIds: readonly string[], fromId: string, toId: string) => {
      const rangeIds = idsInInclusiveRange(orderedIds, fromId, toId);
      if (rangeIds.length === 0) {
        return;
      }
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of rangeIds) {
          next.add(id);
        }
        return next;
      });
    },
    [],
  );

  const deselectAll = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) {
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const value = useMemo(
    () => ({
      selectedIds,
      isSelected,
      toggle,
      selectRange,
      deselectAll,
      clear,
    }),
    [selectedIds, isSelected, toggle, selectRange, deselectAll, clear],
  );

  return (
    <BulkSelectionContext.Provider value={value}>
      {children}
    </BulkSelectionContext.Provider>
  );
}

export function useBulkSelection(): BulkSelectionContextValue | null {
  return useContext(BulkSelectionContext);
}
