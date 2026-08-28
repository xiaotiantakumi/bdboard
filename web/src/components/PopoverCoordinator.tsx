import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

/*
  ヘッダーのポップオーバーは「同時に1つしか開かない」(Header Redesign Turn 4 の規則5)。
  各ポップオーバーは自分の開閉状態を自分で持ったまま、開いたことをこの Coordinator に
  知らせる。Coordinator は他の登録済みポップオーバーを閉じるだけで、状態は持たない。

  Esc と外側クリックによるクローズは useExclusivePopover 側に置いてある。Coordinator が
  無くても(= Provider で囲まれていない単体テスト等でも)その2つは動く。
*/

interface PopoverCoordinatorValue {
  register: (id: string, close: () => void) => () => void;
  notifyOpen: (id: string) => void;
}

const detachedCoordinator: PopoverCoordinatorValue = {
  register: () => () => {},
  notifyOpen: () => {},
};

const PopoverCoordinatorContext = createContext<PopoverCoordinatorValue>(detachedCoordinator);

export function PopoverCoordinatorProvider({ children }: { children: ReactNode }) {
  const closersRef = useRef(new Map<string, () => void>());

  const register = useCallback((id: string, close: () => void) => {
    closersRef.current.set(id, close);
    return () => {
      closersRef.current.delete(id);
    };
  }, []);

  const notifyOpen = useCallback((id: string) => {
    for (const [otherId, close] of closersRef.current) {
      if (otherId !== id) {
        close();
      }
    }
  }, []);

  const value = useMemo<PopoverCoordinatorValue>(
    () => ({ register, notifyOpen }),
    [register, notifyOpen],
  );

  return (
    <PopoverCoordinatorContext.Provider value={value}>
      {children}
    </PopoverCoordinatorContext.Provider>
  );
}

/**
 * ポップオーバーの排他・Esc・外側クリックを引き受ける。返り値の ref を
 * 「ボタンとポップオーバーを両方含む」ラッパー要素に付けること(ボタン自身への
 * クリックが外側クリック扱いになると、開いた瞬間に閉じてしまう)。
 */
export function useExclusivePopover(
  id: string,
  open: boolean,
  onOpenChange: (open: boolean) => void,
): RefObject<HTMLDivElement | null> {
  const coordinator = useContext(PopoverCoordinatorContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(
    () => coordinator.register(id, () => onOpenChangeRef.current(false)),
    [coordinator, id],
  );

  useEffect(() => {
    if (open) {
      coordinator.notifyOpen(id);
    }
  }, [coordinator, id, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (containerRef.current !== null && !containerRef.current.contains(target)) {
        onOpenChangeRef.current(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChangeRef.current(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return containerRef;
}
