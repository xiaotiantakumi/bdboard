// bdboard-sso1.79: useTicketAgentRun.ts から、エージェント実行確認ダイアログの
// フォーカストラップ (キャンセル対象ref・ダイアログref・Escキャンセルハンドラ) を
// move-only で切り出したフック。useFocusTrap へ渡す引数・依存配列は移動前から
// 変えていない (handleCancelAgentRun の依存配列 `[]` は、setConfirmingAgentRun を
// 引数で受け取るようになった後も変えていない — exhaustive-deps の新規警告は
// 依存配列をいじって消さない)。
import { useCallback, useRef } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

export function useAgentRunConfirmDialog(
  confirmingAgentRun: boolean,
  setConfirmingAgentRun: (value: boolean) => void,
) {
  const cancelAgentRunConfirmRef = useRef<HTMLButtonElement>(null);
  const agentRunConfirmRef = useRef<HTMLDivElement>(null);

  const handleCancelAgentRun = useCallback(() => {
    setConfirmingAgentRun(false);
  }, []);

  useFocusTrap({
    containerRef: agentRunConfirmRef,
    initialFocusRef: cancelAgentRunConfirmRef,
    enabled: confirmingAgentRun,
    onEscape: handleCancelAgentRun,
  });

  return { cancelAgentRunConfirmRef, agentRunConfirmRef, handleCancelAgentRun };
}
