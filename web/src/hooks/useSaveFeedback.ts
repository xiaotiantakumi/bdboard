import { useCallback, type ReactNode } from 'react';
import { useAutoClearedValue } from './useAutoClearedValue';

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

interface FeedbackValue {
  readonly message: ReactNode;
  readonly isError: boolean;
}

const EMPTY_FEEDBACK: FeedbackValue = { message: '', isError: false };

/**
 * 保存フィードバックの表示と、成功時の自動消去タイマーをまとめて持つ (bdboard-ifff)。
 *
 * タイマーとアンマウント後の no-op は [useAutoClearedValue] が持っている。
 * ここが足しているのは「成功は自動で消えるがエラーは残る」という保存固有の意味
 * だけ: showSuccess が show (自動消去あり)、showError が hold (自動消去なし)。
 * どちらも先行タイマーを必ずクリアするので、成功表示の直後にエラーが来ても、
 * 先に仕掛けた自動消去がそのエラー文言を消してしまうことは無い。
 */
export function useSaveFeedback(): SaveFeedback {
  const feedback = useAutoClearedValue<FeedbackValue>(
    EMPTY_FEEDBACK,
    SAVE_FEEDBACK_MS,
  );
  const { show, hold } = feedback;

  const showSuccess = useCallback(
    (next: ReactNode) => {
      show({ message: next, isError: false });
    },
    [show],
  );

  const showError = useCallback(
    (next: ReactNode) => {
      hold({ message: next, isError: true });
    },
    [hold],
  );

  return {
    message: feedback.value.message,
    isError: feedback.value.isError,
    showSuccess,
    showError,
  };
}
