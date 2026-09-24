import type { RefObject } from 'react';
import type { ProjectDto } from '../../api';

/** ChatPanel の props(bdboard-sso1.83 第15b段で ChatPanel.tsx から移した。中身は元のまま)。 */
export interface ChatPanelProps {
  projects: readonly ProjectDto[];
  initialProjectId?: string;
  initialInput?: string;
  ticketContextToken?: number;
  onProjectIdChange?: (projectId: string) => void;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  onClose: () => void;
}

/**
 * ChatPanel が useRef で作り、controller(chat/useChatPanelController.ts)へ渡す DOM の ref。
 * TicketDetailPanel(ticket-detail/useTicketDetailController.ts)と同じく、ref は
 * コンポーネント側で作って渡すだけにし、controller の戻り値からは JSX へ返さない
 * (react-hooks/refs が「ref をデータと同じオブジェクトに束ねて返す」形を render 中の
 * ref 読み取りと誤検知するため)。fileInputRef は JSX だけが使うので ChatPanel に残す。
 */
export interface ChatPanelDomRefs {
  panelRef: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  threadDrawerRef: RefObject<HTMLDivElement | null>;
  threadDrawerCloseButtonRef: RefObject<HTMLButtonElement | null>;
  messagesRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
}

export type ChatPanelControllerParams = ChatPanelProps & ChatPanelDomRefs;
