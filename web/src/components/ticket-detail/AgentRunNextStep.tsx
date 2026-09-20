// bdboard-sso1.5: TicketDetailPanel.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import { buildRunNextStepCommand } from '../agentRunShared';
import type { AgentRunNextStepDto } from '../../api';
import { AGENT_RUN_NEXT_STEP_LABEL } from './agentRun';
import type { NextStepCopyTarget } from './types';

/**
 * run 完了後に人が run の外で回す検証コマンド (bdboard-pkr6.11 仕様4)。
 * run 内では検証できないので、終わったあとの導線をここに置く。
 */
export function AgentRunNextStep({
  nextStep,
  target,
  copied,
  onCopy,
}: {
  nextStep: AgentRunNextStepDto;
  target: NextStepCopyTarget;
  copied: boolean;
  onCopy: (target: NextStepCopyTarget, nextStep: AgentRunNextStepDto) => void;
}) {
  const command = buildRunNextStepCommand(nextStep);

  return (
    <div className="agent-run-next-step">
      <span className="agent-run-next-step-label">{AGENT_RUN_NEXT_STEP_LABEL}:</span>
      <code className="agent-run-next-step-command">{command}</code>
      <button
        type="button"
        className="btn btn-small agent-run-next-step-copy"
        aria-label={`次に実行するコマンドをコピー: ${command}`}
        onClick={() => onCopy(target, nextStep)}
      >
        {copied ? 'コピーしました' : 'コピー'}
      </button>
    </div>
  );
}
