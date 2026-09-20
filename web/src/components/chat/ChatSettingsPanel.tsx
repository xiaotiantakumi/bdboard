import { formatAgentOptionLabel } from './agentOptions';
import type { ChatAgentDto } from '../../api';

/**
 * チャット設定パネル(エージェント/モデル選択 + 権限警告 + ヘルプ文言)。
 *
 * bdboard-sso1.2 PR-C: ChatPanel.tsx から状態を持たない表示部分を抜き出す
 * 段階的分割の一環(bdboard-78ve の「concern 別 custom hooks への分割はやらない」
 * という判断は変えない — ここで動くのは props だけで、状態・副作用は一切持たない)。
 * 元の JSX をそのまま移しただけで、振る舞いは変えていない。
 */
export interface ChatSettingsPanelProps {
  summaryParts: readonly string[];
  threadError: string | null;
  agents: readonly ChatAgentDto[];
  selectedAgentId: string;
  isSending: boolean;
  onAgentChange: (agentId: string) => void;
  selectedAgent: ChatAgentDto | undefined;
  showModelSelect: boolean;
  effectiveModelId: string;
  onModelChange: (modelId: string) => void;
}

export function ChatSettingsPanel({
  summaryParts,
  threadError,
  agents,
  selectedAgentId,
  isSending,
  onAgentChange,
  selectedAgent,
  showModelSelect,
  effectiveModelId,
  onModelChange,
}: ChatSettingsPanelProps) {
  return (
    <details className="chat-panel-settings">
      <summary className="chat-panel-settings-summary">{summaryParts.join(' — ')}</summary>
      <div className="chat-panel-settings-body">
        {threadError !== null && (
          <p className="chat-message-error chat-thread-error" role="alert">
            {threadError}
          </p>
        )}

        {agents.length > 0 && (
          <select
            className="chat-agent-select"
            aria-label="チャットエージェント"
            value={selectedAgentId}
            disabled={isSending}
            onChange={(event) => onAgentChange(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {formatAgentOptionLabel(agent)}
              </option>
            ))}
          </select>
        )}

        {selectedAgent !== undefined && showModelSelect && (
          <select
            className="chat-model-select"
            aria-label="モデル"
            value={effectiveModelId}
            disabled={isSending}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {(selectedAgent.models ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        )}

        {selectedAgent !== undefined && selectedAgent.capability !== 'bd-only' && (
          <p className="chat-agent-capability-warning" role="note">
            このエージェントは bd チケット操作以外の権限を持ちます（
            {selectedAgent.capability}）。
          </p>
        )}

        {selectedAgent === undefined || selectedAgent.capability === 'bd-only' ? (
          <p className="detail-help">
            このチャットは localhost からのみ利用できます。AIが実行できるのは、このプロジェクトの
            bdチケット操作(一覧・詳細・claim・状態変更・クローズ・コメント追加)だけです。
          </p>
        ) : null}
      </div>
    </details>
  );
}
