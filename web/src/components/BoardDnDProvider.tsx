import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  postTicketQuickAction,
  postTicketQuickActionUndo,
  type Lane,
  type QuickActionRequest,
} from '../api';
import { describeWriteError } from '../writeAccessMessage';
import { resolveDropAction } from '../dndDropRules';
import { planQuickActionUndo } from '../quickActionUndo';
import { useUndoSnackbar } from './UndoSnackbar';

export const BOARD_CARD_DRAG_MIME = 'application/x-bdboard-card';

export interface BoardCardDragPayload {
  ticketId: string;
  sourceLane: Lane;
}

interface DropHoverState {
  lane: Lane;
  allowed: boolean;
}

interface BoardDnDContextValue {
  dragging: BoardCardDragPayload | null;
  dropHover: DropHoverState | null;
  dndError: string | null;
  isMutating: boolean;
  suppressClickRef: RefObject<boolean>;
  onCardDragStart: (
    payload: BoardCardDragPayload,
    event: DragEvent<HTMLElement>,
  ) => void;
  onCardDragEnd: () => void;
  onLaneDragOver: (targetLane: Lane, event: DragEvent<HTMLElement>) => void;
  onLaneDrop: (targetLane: Lane, event: DragEvent<HTMLElement>) => void;
}

const BoardDnDContext = createContext<BoardDnDContextValue | null>(null);

function readDragPayload(
  event: DragEvent<HTMLElement>,
  fallback: BoardCardDragPayload | null = null,
): BoardCardDragPayload | null {
  const mimePayload = event.dataTransfer.getData(BOARD_CARD_DRAG_MIME);
  const textPayload =
    mimePayload !== '' ? mimePayload : event.dataTransfer.getData('text/plain');
  if (textPayload === '') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(textPayload) as BoardCardDragPayload;
    if (
      typeof parsed.ticketId === 'string' &&
      typeof parsed.sourceLane === 'string'
    ) {
      return parsed;
    }
  } catch {
    // ignore malformed payload
  }
  return fallback;
}

function formatMutationError(error: unknown): string {
  return describeWriteError(error, 'クイックアクションの実行に失敗しました');
}

export function BoardDnDProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const undoSnackbar = useUndoSnackbar();
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState<BoardCardDragPayload | null>(null);
  const [dropHover, setDropHover] = useState<DropHoverState | null>(null);
  const [dndError, setDndError] = useState<string | null>(null);

  const quickActionMutation = useMutation({
    mutationFn: async (request: { ticketId: string; body: QuickActionRequest }) => {
      await postTicketQuickAction(request.ticketId, request.body);
      return request;
    },
    onSuccess: async (request) => {
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setDndError(null);

      // DnDのクイックアクション(claim/close)はpriority操作を含まないため
      // previousPriorityは常に不要。誤操作からの復帰用にUndoスナックバーを出す
      // (bdboard-3tw.69: 確認ダイアログの代わりの事後Undo)。
      const plan = planQuickActionUndo(request.body);
      if (plan !== null) {
        undoSnackbar?.showUndo({
          message: plan.message,
          onUndo: async () => {
            await postTicketQuickActionUndo(request.ticketId, plan.undoRequest);
            await queryClient.invalidateQueries({ queryKey: ['board'] });
            await queryClient.invalidateQueries({
              queryKey: ['ticket', request.ticketId],
            });
          },
        });
      }
    },
    onError: (error) => {
      setDndError(formatMutationError(error));
    },
  });

  const executeQuickAction = useCallback(
    (ticketId: string, body: QuickActionRequest) => {
      quickActionMutation.mutate({ ticketId, body });
    },
    [quickActionMutation],
  );

  const onCardDragStart = useCallback(
    (payload: BoardCardDragPayload, event: DragEvent<HTMLElement>) => {
      suppressClickRef.current = false;
      setDndError(null);
      setDragging(payload);
      const serialized = JSON.stringify(payload);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(BOARD_CARD_DRAG_MIME, serialized);
      // Some browsers require a text/* payload for intra-page drag-and-drop.
      event.dataTransfer.setData('text/plain', serialized);
    },
    [],
  );

  const onCardDragEnd = useCallback(() => {
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    setDragging(null);
    setDropHover(null);
  }, []);

  const onLaneDragOver = useCallback(
    (targetLane: Lane, event: DragEvent<HTMLElement>) => {
      const payload = readDragPayload(event, dragging);
      if (payload === null) {
        return;
      }

      event.preventDefault();
      const allowed = resolveDropAction(payload.sourceLane, targetLane).kind !== 'reject';
      event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
      setDropHover({ lane: targetLane, allowed });
    },
    [dragging],
  );

  const onLaneDrop = useCallback(
    (targetLane: Lane, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDropHover(null);

      const payload = readDragPayload(event, dragging);
      if (payload === null) {
        return;
      }

      const action = resolveDropAction(payload.sourceLane, targetLane);
      switch (action.kind) {
        case 'reject':
          return;
        case 'claim':
          executeQuickAction(payload.ticketId, { action: 'claim' });
          return;
        case 'close':
          executeQuickAction(payload.ticketId, { action: 'close' });
          return;
      }
    },
    [dragging, executeQuickAction],
  );

  const value = useMemo<BoardDnDContextValue>(
    () => ({
      dragging,
      dropHover,
      dndError,
      isMutating: quickActionMutation.isPending,
      suppressClickRef,
      onCardDragStart,
      onCardDragEnd,
      onLaneDragOver,
      onLaneDrop,
    }),
    [
      dragging,
      dropHover,
      dndError,
      quickActionMutation.isPending,
      onCardDragStart,
      onCardDragEnd,
      onLaneDragOver,
      onLaneDrop,
    ],
  );

  return (
    <BoardDnDContext.Provider value={value}>{children}</BoardDnDContext.Provider>
  );
}

export function useBoardDnD(): BoardDnDContextValue | null {
  return useContext(BoardDnDContext);
}
