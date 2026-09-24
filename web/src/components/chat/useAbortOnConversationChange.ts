import { useEffect, type MutableRefObject } from 'react';

/**
 * bdboard-sso1.83 第13a段: ChatPanel.tsx の旧 E4(会話キー変化時に進行中の送信リクエストを
 * abort する effect)を move-only で抜き出したもの。呼び出し位置は元の E4 の位置のまま
 * (E3(useAgentFromConversationSync)より後・E5 より前。useFocusTrap ×2(パネル/ドロワーの
 * フォーカストラップ)より**後**に置くこと — state フック(useChatSendState())へ同居させると
 * useChatSendState() 自体は focus trap より前で呼ばれるため、E4 がそちらへ引きずられて
 * focus trap より前へ動いてしまう。それを避けるためにこのフックを分離し、呼び出し側では
 * 元の E4 と同じ「focus trap の後」の位置で呼ぶ)。
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
