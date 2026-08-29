import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** 保存成功のフィードバックを自動で消すまでの時間 */
export const SAVE_FEEDBACK_MS = 2000;

export interface SaveFeedback {
  readonly message: ReactNode;
  readonly isError: boolean;
  /** 成功時。SAVE_FEEDBACK_MS 後に自動で消える。 */
  readonly showSuccess: (message: ReactNode) => void;
  /** 失敗時。自動では消えない(ユーザーが読んで対処するため)。 */
  readonly showError: (message: ReactNode) => void;
}

/**
 * 保存フィードバックの表示と、成功時の自動消去タイマーをまとめて持つ。
 *
 * bdboard-ifff: 呼び出し側が素の `window.setTimeout(() => setFeedback(''), ...)` を
 * 書くと、タイマーIDが誰にも保持されないためアンマウント時にクリアできない。
 * 生き残ったタイマーが後から setState を呼び、テストでは環境が破棄済みの
 * jsdom で `window is not defined` を投げる。vitest はこれを「テスト環境破棄後の
 * 未捕捉エラー」として扱うので、**個々のテストは全て pass しているのにプロセスが
 * exit 1 で落ちる**。CI が落ちた PR の差分に SettingsPanel が入っていなくても
 * 起きるので、原因が分かりにくい壊れ方をする。
 *
 * タイマーIDを ref で持ち、(1) アンマウント時 (2) 次のフィードバックを出すとき の
 * 両方で必ずクリアする。(2) があるので、成功表示の直後にエラーが来ても、
 * 先に仕掛けた自動消去がそのエラー文言を消してしまうことは無い。
 *
 * さらにアンマウント後は show* 自体を no-op にする。タイマーのクリアだけでは
 * 足りないため: 保存の onSuccess は invalidateQueries や postRefresh を await して
 * から表示を出すので、その継続がアンマウント後に解決しうる。そこで show* を
 * 呼ぶと `window.setTimeout` の `window` 参照自体が
 * 「環境破棄後の ReferenceError」になり、クリーンアップ済みの新しいタイマーを
 * 誰も片付けられない。SettingsPanel.test.tsx にはこの継続の遅れを避けるための
 * 「保存完了の表示を待ってからテストを終える」という回避策が入っているが、
 * それは呼び出し側の作法に頼る話で、フック自体が安全である方が確実。
 */
export function useSaveFeedback(): SaveFeedback {
  const [message, setMessage] = useState<ReactNode>('');
  const [isError, setIsError] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const showSuccess = useCallback(
    (next: ReactNode) => {
      if (!mountedRef.current) {
        return;
      }
      clearTimer();
      setIsError(false);
      setMessage(next);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        setMessage('');
      }, SAVE_FEEDBACK_MS);
    },
    [clearTimer],
  );

  const showError = useCallback(
    (next: ReactNode) => {
      if (!mountedRef.current) {
        return;
      }
      clearTimer();
      setIsError(true);
      setMessage(next);
    },
    [clearTimer],
  );

  return { message, isError, showSuccess, showError };
}
