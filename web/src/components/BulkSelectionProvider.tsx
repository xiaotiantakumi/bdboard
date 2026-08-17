import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface BulkSelectionContextValue {
  selectedIds: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
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
      deselectAll,
      clear,
    }),
    [selectedIds, isSelected, toggle, deselectAll, clear],
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
