import { CHAT_QUICK_COMMANDS, type ChatQuickCommand } from '../../chatQuickCommands';

/**
 * チャット入力欄のクイックコマンド行(チップボタン群)。
 *
 * bdboard-sso1.2 PR-D: ChatPanel.tsx から状態を持たない表示部分を抜き出す
 * 段階的分割の一環。CHAT_QUICK_COMMANDS 定数はこのコンポーネントが自前で
 * import する(元の呼び出し側と同じ定数を参照するだけで、状態・副作用は
 * 一切持たない)。disabled 判定式は元の JSX のロジックをそのまま移した。
 */
export interface ChatQuickCommandsProps {
  isSending: boolean;
  isHistoryPending: boolean;
  selectedProjectId: string;
  onQuickCommand: (command: ChatQuickCommand) => void;
}

export function ChatQuickCommands({
  isSending,
  isHistoryPending,
  selectedProjectId,
  onQuickCommand,
}: ChatQuickCommandsProps) {
  return (
    <div className="chat-quick-commands" role="group" aria-label="クイックコマンド">
      {CHAT_QUICK_COMMANDS.map((command) => (
        <button
          key={command.id}
          type="button"
          className="chat-quick-command-chip"
          disabled={isSending || isHistoryPending || selectedProjectId === ''}
          aria-label={`${command.label}を入力欄に挿入`}
          onClick={() => onQuickCommand(command)}
        >
          {command.label}
        </button>
      ))}
    </div>
  );
}
