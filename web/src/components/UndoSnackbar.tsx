import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../api';
import {
  describeWriteError,
  writeAccessErrorMessage,
} from '../writeAccessMessage';

// 誤タップ・隣カード誤操作対策のUndo(bdboard-3tw.69)。確認ダイアログの代わりに
// 事後Undoで速さと安全性を両立するのが狙いなので、表示時間は「気づいて押せる」程度に
// 長めに取る。
const UNDO_VISIBLE_MS = 8000;
const UNDO_RESULT_MS = 3000;

export interface UndoSnackbarRequest {
  /** スナックバーに表示するメッセージ(例: "着手しました") */
  readonly message: string;
  /** 「元に戻す」押下時に実行する逆操作。成功で resolve、失敗で reject する。 */
  readonly onUndo: () => Promise<void>;
}

type SnackbarState =
  | { kind: 'idle' }
  | { kind: 'visible'; message: string; onUndo: () => Promise<void> }
  | { kind: 'undoing'; message: string }
  | { kind: 'undone' }
  | { kind: 'undo-failed'; detail: string };

interface UndoSnackbarContextValue {
  showUndo: (request: UndoSnackbarRequest) => void;
}

const UndoSnackbarContext = createContext<UndoSnackbarContextValue | null>(
  null,
);

function describeUndoError(error: unknown): string {
  // bdboard-3tw.82 / bdboard-50n: 409 と 403 の日本語化は writeAccessMessage に集約。
  if (error instanceof ApiError && error.status === 409) {
    return describeWriteError(error, '元に戻せませんでした');
  }
  // bdboard-cu4: トンネル経由で認可が足りない 403 は、行動可能な説明に差し替える。
  const writeAccessMessage = writeAccessErrorMessage(error);
  if (writeAccessMessage !== null) {
    return writeAccessMessage;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return '元に戻せませんでした';
}

export function UndoSnackbarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SnackbarState>({ kind: 'idle' });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPendingTimeout();
    };
  }, [clearPendingTimeout]);

  const showUndo = useCallback(
    ({ message, onUndo }: UndoSnackbarRequest) => {
      // bdboard-ty72: 呼び出し元は4箇所とも mutation の onSuccess
      // (HygienePanel / TicketDetailPanel / BoardDnDProvider / BulkActionBar) で、
      // invalidateQueries を await した後に呼ぶ。プロバイダ自体がその間に
      // アンマウントしていると、下の setTimeout がクリーンアップ後に仕掛けられる。
      if (!mountedRef.current) {
        return;
      }
      clearPendingTimeout();
      setState({ kind: 'visible', message, onUndo });
      timeoutRef.current = setTimeout(() => {
        setState({ kind: 'idle' });
        timeoutRef.current = null;
      }, UNDO_VISIBLE_MS);
    },
    [clearPendingTimeout],
  );

  const scheduleAutoDismiss = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      setState({ kind: 'idle' });
      timeoutRef.current = null;
    }, UNDO_RESULT_MS);
  }, []);

  const handleUndoClick = useCallback(() => {
    if (state.kind !== 'visible') {
      return;
    }
    clearPendingTimeout();
    const { message, onUndo } = state;
    setState({ kind: 'undoing', message });
    onUndo()
      .then(() => {
        // bdboard-ty72: 逆操作の完了はアンマウント後に届きうる。ここで進むと
        // 誰も片付けられない自動消去タイマーを仕掛けることになる (タイマーIDを
        // ref に持っていても、クリーンアップはもう走り終わっている)。
        if (!mountedRef.current) {
          return;
        }
        setState({ kind: 'undone' });
        scheduleAutoDismiss();
      })
      .catch((error: unknown) => {
        // 失敗も同じ。表示先がもう無いので握り潰してよい (catch はしているので
        // 未処理の rejection にはならない)。
        if (!mountedRef.current) {
          return;
        }
        setState({ kind: 'undo-failed', detail: describeUndoError(error) });
        scheduleAutoDismiss();
      });
  }, [state, clearPendingTimeout, scheduleAutoDismiss]);

  const handleDismiss = useCallback(() => {
    clearPendingTimeout();
    setState({ kind: 'idle' });
  }, [clearPendingTimeout]);

  const contextValue = useMemo<UndoSnackbarContextValue>(
    () => ({ showUndo }),
    [showUndo],
  );

  return (
    <UndoSnackbarContext.Provider value={contextValue}>
      {children}
      {state.kind !== 'idle' && (
        <div className="undo-snackbar" role="status" aria-live="polite">
          {state.kind === 'visible' && (
            <>
              <span className="undo-snackbar-message">{state.message}</span>
              <button
                type="button"
                className="btn undo-snackbar-action"
                onClick={handleUndoClick}
              >
                元に戻す
              </button>
              <button
                type="button"
                className="undo-snackbar-dismiss"
                aria-label="閉じる"
                onClick={handleDismiss}
              >
                ×
              </button>
            </>
          )}
          {state.kind === 'undoing' && (
            <span className="undo-snackbar-message">取り消しています…</span>
          )}
          {state.kind === 'undone' && (
            <span className="undo-snackbar-message">元に戻しました</span>
          )}
          {state.kind === 'undo-failed' && (
            <span className="undo-snackbar-message undo-snackbar-error">
              元に戻せませんでした: {state.detail}
            </span>
          )}
        </div>
      )}
    </UndoSnackbarContext.Provider>
  );
}

export function useUndoSnackbar(): UndoSnackbarContextValue | null {
  return useContext(UndoSnackbarContext);
}
