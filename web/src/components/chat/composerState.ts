/**
 * チャット入力フォーム(ChatComposer)の送信可否判定と aria-describedby の
 * 組み立てを行う純関数群。
 *
 * bdboard-sso1.83 第7段: ChatPanel.tsx の JSX 内にインラインで書かれていた
 * 2つの式(送信ボタンの disabled 判定、aria-describedby の結合)を、
 * ChatComposer.tsx への JSX 抽出と合わせてここへ移した。判定式・結合順序・
 * コメントは1文字も変えていない。状態・副作用は一切持たない。
 */

export interface ComputeSubmitDisabledInput {
  selectedProjectId: string;
  isSending: boolean;
  isHistoryPending: boolean;
  chatUnsupported: boolean;
  selectedAgentUnavailable: boolean;
  hasUnsupportedAttachments: boolean;
  hasUnresolvedProjectRecovery: boolean;
  currentInput: string;
  attachmentsCount: number;
}

export function computeSubmitDisabled({
  selectedProjectId,
  isSending,
  isHistoryPending,
  chatUnsupported,
  selectedAgentUnavailable,
  hasUnsupportedAttachments,
  hasUnresolvedProjectRecovery,
  currentInput,
  attachmentsCount,
}: ComputeSubmitDisabledInput): boolean {
  return (
    selectedProjectId === '' ||
    isSending ||
    isHistoryPending ||
    chatUnsupported ||
    selectedAgentUnavailable ||
    hasUnsupportedAttachments ||
    // bdboard-v3ag: 配信停止からの turn-status 回収が終わるまで
    // 再送を止める(hasUnresolvedProjectRecovery の定義コメント参照)。
    hasUnresolvedProjectRecovery ||
    (currentInput.trim() === '' && attachmentsCount === 0)
  );
}

export function joinDescribedBy(ids: readonly (string | null)[]): string | undefined {
  return ids.filter((id): id is string => id !== null).join(' ') || undefined;
}
