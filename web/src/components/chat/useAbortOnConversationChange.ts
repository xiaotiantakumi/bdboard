import { useEffect, type MutableRefObject } from 'react';

/**
 * bdboard-sso1.83 第13a段: ChatPanel.tsx の旧 E4(会話キー変化時に進行中の送信リクエストを
 * abort する effect)を move-only で抜き出したもの。呼び出し位置は元の E4 の位置のまま
 * (E3 より後・E5 より前。focus trap(useFocusTrap ×2)より後には来ない — 呼び出し側で
 * useChatSendState() より後・useFocusTrap より前に置くこと)。
 */
export function useAbortOnConversationChange(
  requestAbortControllerRef: MutableRefObject<AbortController | null>,
  currentConversationKey: string,
): void {
  useEffect(() => {
    return () => {
      requestAbortControllerRef.current?.abort();
      requestAbortControllerRef.current = null;
    };
  }, [currentConversationKey, requestAbortControllerRef]);
}
