// bdboard-sso1.5 (PR-H): TicketDetailPanel.tsx の「bdコマンド」表示ブロック
// (コピーボタン + コピー結果フィードバック) を移動しただけのコンポーネント。
// コピー結果の state (copyFeedback / ariaLiveMessage) は親 (TicketDetailPanel)
// の useAutoClearedValue に残し、値とハンドラを props で受け取る表示専用
// コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えて
// いない。
import {
  BD_COMMAND_DEFINITIONS,
  buildBdCommand,
  type BdCommandKind,
} from '../../bdCommands';
import type { CopyDisplay } from './types';

export interface TicketBdCommandSectionProps {
  ticketId: string;
  projectRootPath: string | undefined;
  copyFeedback: CopyDisplay['feedback'];
  ariaLiveMessage: string;
  onCopyCommand: (kind: BdCommandKind) => void;
}

export function TicketBdCommandSection({
  ticketId,
  projectRootPath,
  copyFeedback,
  ariaLiveMessage,
  onCopyCommand,
}: TicketBdCommandSectionProps) {
  return (
    <div className="detail-section">
      <h3>bdコマンド</h3>
      <p className="detail-help">
        クリップボードにコピーしてターミナルで実行できます
      </p>
      <div className="bd-command-actions">
        {BD_COMMAND_DEFINITIONS.map(({ kind, label }) => {
          const command = buildBdCommand(kind, ticketId, projectRootPath);
          const showSuccess =
            copyFeedback?.kind === 'success' && copyFeedback.command === kind;

          return (
            <button
              key={kind}
              type="button"
              className="btn bd-command-btn"
              onClick={() => onCopyCommand(kind)}
              aria-label={`${label}コマンドをコピー: ${command}`}
            >
              {showSuccess ? 'コピーしました' : label}
            </button>
          );
        })}
      </div>
      {copyFeedback?.kind === 'error' && (
        <p className="error-message">コピーできませんでした</p>
      )}
      <p className="sr-only" aria-live="polite">
        {ariaLiveMessage}
      </p>
    </div>
  );
}
