// bdboard-sso1.5: TicketDetailPanel.tsx のパネル外枠 div に付いていた 'c'
// キーボードショートカット(コメント入力欄へフォーカス)を、挙動を変えずに
// このカスタムフックへ抽出した。元は JSX 内のインライン onKeyDown ハンドラ
// だったが、判定ロジックそのものは1文字も変えていない。
//
// useCallback にはしていない: 元がレンダーごとに新しい関数を作るインライン
// ハンドラだったので、このフックも呼ぶたびに新しい関数を返す。disabled が
// クロージャに閉じ込められる点も含め、挙動を完全に同一に保つための選択。
import type { KeyboardEvent, RefObject } from 'react';

export interface UseCommentFocusShortcutOptions {
  /** コメント入力欄の ref。null または disabled のときは何もしない。 */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** true の間はショートカットを無効化する (quick action / agent run 確認中など)。 */
  disabled: boolean;
}

export function useCommentFocusShortcut({
  textareaRef,
  disabled,
}: UseCommentFocusShortcutOptions) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    if (event.key !== 'c') {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
    }
    if (disabled) {
      return;
    }
    const textarea = textareaRef.current;
    if (textarea === null || textarea.disabled) {
      return;
    }
    event.preventDefault();
    textarea.focus();
    if (typeof textarea.scrollIntoView === 'function') {
      textarea.scrollIntoView({ block: 'nearest' });
    }
  };
}
