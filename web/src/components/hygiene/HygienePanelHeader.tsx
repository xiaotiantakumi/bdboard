// bdboard-sso1.74: HygienePanel.tsx のヘッダー部分(タイトル/サブタイトル/close証拠
// なし注記/コピー・修復フィードバックの aria-live 欄)を、挙動を変えずに表示専用
// コンポーネントへ移動しただけのファイル。DOM構造・クラス名・aria属性・順序は
// 移動前と同一。
import type { HygieneResponseDto } from '../../api';

export interface HygienePanelHeaderProps {
  readonly closeEvidence: HygieneResponseDto['closeEvidence'] | undefined;
  readonly closedWithoutEvidenceCount: number;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly ariaLiveMessage: string;
  readonly repairStatusMessage: string;
}

export function HygienePanelHeader({
  closeEvidence,
  closedWithoutEvidenceCount,
  isLoading,
  isError,
  ariaLiveMessage,
  repairStatusMessage,
}: HygienePanelHeaderProps) {
  const showCloseEvidenceNote =
    closeEvidence != null && closeEvidence.unknownCount > 0;

  return (
    <div className="hygiene-panel-header">
      <h2 className="hygiene-panel-title">ボード健全性</h2>
      <p className="hygiene-panel-subtitle">
        台帳の腐りを検知した警告一覧です
      </p>
      {!isLoading && !isError && showCloseEvidenceNote && (
        <p className="hygiene-panel-close-evidence-note" role="status">
          close 証拠なし: {closedWithoutEvidenceCount}件（
          {closeEvidence.unknownCount}件は未確認）
          {' '}
          未確認のぶんは判定を見送っています（時間をおくと確定します）
        </p>
      )}
      <span className="hygiene-panel-feedback" role="status" aria-live="polite">
        {ariaLiveMessage}
      </span>
      <span
        className="hygiene-panel-repair-status"
        role="status"
        aria-live="polite"
      >
        {repairStatusMessage}
      </span>
    </div>
  );
}
