import { AppOverlayGroup } from './AppOverlayGroup';
import type { useAppController } from './useAppController';

export interface AppOverlaySectionProps {
  controller: ReturnType<typeof useAppController>;
}

/**
 * App.tsx の JSX 本体のうち AppOverlayGroup 呼び出し部分(旧461〜515行目)を
 * 切り出した表示専用コンポーネント(bdboard-62p4 第6段、AppBody.tsx から分離
 * — AppBody.tsx 単体で200行に収まらなかったため)。JSX 自体は1文字も
 * 変えていない。
 */
export function AppOverlaySection({ controller }: AppOverlaySectionProps) {
  const {
    selectedTicketId,
    projectRootPaths,
    pendingDecisionsById,
    prLinksById,
    handleCloseDetail,
    chatAvailable,
    overlays,
    handleSelectTicket,
    canGoBackTicket,
    goBackTicket,
    isTicketOnBoard,
    handleFilterByEpic,
    handleRecordRecentTicket,
    availableLabels,
    chatProjects,
    selectedProjectIds,
    lastChatProjectId,
    setLastChatProjectId,
    paletteActions,
    recentTickets,
  } = controller;

  return (
    <AppOverlayGroup
      ticketDetail={{
        selectedTicketId,
        projectRootPaths,
        pendingDecision:
          selectedTicketId !== null ? pendingDecisionsById.get(selectedTicketId) : undefined,
        prLink: selectedTicketId !== null ? prLinksById.get(selectedTicketId) : undefined,
        onClose: handleCloseDetail,
        onChatAboutTicket: chatAvailable ? overlays.handleChatAboutTicket : undefined,
        onOpenTicket: handleSelectTicket,
        onBackTicket: canGoBackTicket ? goBackTicket : undefined,
        isMaximized: overlays.detailMaximized,
        onToggleMaximized: overlays.handleToggleDetailMaximized,
        isTicketOnBoard,
        onFilterByEpic: handleFilterByEpic,
        onTicketViewed: handleRecordRecentTicket,
        availableLabels: availableLabels ?? [],
      }}
      sessionList={{
        open: overlays.sessionListOpen,
        projectId: overlays.sessionListProjectId,
        onClose: overlays.handleCloseSessionList,
      }}
      shortcuts={{ open: overlays.shortcutsOpen, onClose: overlays.handleCloseShortcuts }}
      help={{ open: overlays.helpOpen, onClose: overlays.handleCloseHelp }}
      search={{
        open: overlays.searchOpen,
        onClose: overlays.handleCloseSearch,
        onSelect: handleSelectTicket,
        actions: paletteActions,
        recentTickets,
      }}
      tunnel={{ open: overlays.tunnelModalOpen, onClose: overlays.handleCloseTunnel }}
      chat={{
        open: overlays.chatOpen,
        projects: chatProjects,
        initialProjectId:
          overlays.chatContext?.projectId ??
          (selectedProjectIds.length === 1
            ? selectedProjectIds[0]
            : lastChatProjectId !== ''
              ? lastChatProjectId
              : undefined),
        initialInput:
          overlays.chatContext === undefined
            ? undefined
            : `${overlays.chatContext.ticketId} について: `,
        ticketContextToken:
          overlays.chatContext === undefined ? undefined : overlays.chatContextToken,
        onProjectIdChange: setLastChatProjectId,
        isTicketOnBoard,
        onOpenTicket: handleSelectTicket,
        onClose: overlays.handleCloseChat,
      }}
    />
  );
}
