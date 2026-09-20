import { ErrorBoundary } from '../ErrorBoundary';
import { ChatPanel } from '../ChatPanel';
import type { ProjectDto } from '../../api';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * 開閉状態・チャット文脈 (chatContext 由来の initialProjectId/initialInput) は
 * App 側が state で持ち続け、ここには props としてのみ渡す。挙動は一切変えて
 * いない。
 */
export interface AppChatOverlayProps {
  open: boolean;
  projects: readonly ProjectDto[];
  initialProjectId: string | undefined;
  initialInput: string | undefined;
  ticketContextToken: number | undefined;
  onProjectIdChange: (projectId: string) => void;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  onClose: () => void;
}

export function AppChatOverlay({
  open,
  projects,
  initialProjectId,
  initialInput,
  ticketContextToken,
  onProjectIdChange,
  isTicketOnBoard,
  onOpenTicket,
  onClose,
}: AppChatOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <ErrorBoundary label="チャット" resetLabel="閉じる" onReset={onClose} overlay>
      <ChatPanel
        projects={projects}
        initialProjectId={initialProjectId}
        initialInput={initialInput}
        ticketContextToken={ticketContextToken}
        onProjectIdChange={onProjectIdChange}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
        onClose={onClose}
      />
    </ErrorBoundary>
  );
}
