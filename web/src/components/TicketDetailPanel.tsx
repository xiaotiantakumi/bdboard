// bdboard-sso1.5: このファイルはかつて2743行(旧89箇所のフック呼び出し+セクション
// 群を並べる本体JSX)を持っていた。行数は一連の move-only 抽出(PR-A〜PR-L,
// PR#648, PR#656)で680まで縮めた後、今回の段でさらに構造変更を行った:
// (1) 残っていたフック呼び出し群(パネル外枠に必要な最小限を除く)を
//     useTicketDetailController.ts(+ 分割先の useTicketDetailQueries.ts)へ
//     1つの組み立てフックとして集約し、
// (2) セクション群を並べる本体JSXを TicketDetailBody.tsx /
//     TicketDetailSecondaryBody.tsx (表示専用) へ、関心事ごとにグループ化した
//     props オブジェクトを渡す形で切り出した。
// このファイルに残るのは、パネルの外枠(overlay/resize-handle/'c'ショートカット
// のonKeyDown/ヘッダー呼び出し/読み込み・エラー表示)と、コントローラの呼び出し
// だけ。フックの呼び出し順は変えていない
// (useResizableSidePanel → useTicketDetailController 内部の各フック、という
// 順序は移動前の detailPanel → queryClient → ... の順序と同じ)。
import { useRef } from 'react';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import { type TicketDetailPanelProps } from './ticket-detail/types';
import {
  AGENT_RUN_LOG_LOCAL_ONLY_HELP,
  AGENT_RUN_NEXT_STEP_LABEL,
} from './ticket-detail/agentRun';
import { TicketDetailHeaderSection } from './ticket-detail/TicketDetailHeaderSection';
import { TicketDetailBody } from './ticket-detail/TicketDetailBody';
import { TicketDetailSecondaryBody } from './ticket-detail/TicketDetailSecondaryBody';
import { useTicketDetailController } from './ticket-detail/useTicketDetailController';

export type { TicketDetailPanelProps };
export { AGENT_RUN_LOG_LOCAL_ONLY_HELP, AGENT_RUN_NEXT_STEP_LABEL };

export function TicketDetailPanel({
  ticketId,
  projectRootPaths,
  pendingDecision,
  prLink,
  onClose,
  onChatAboutTicket,
  onOpenTicket,
  onBackTicket,
  isTicketOnBoard,
  onFilterByEpic,
  onTicketViewed,
  isMaximized,
  onToggleMaximized,
  availableLabels = [],
}: TicketDetailPanelProps) {
  const detailPanel = useResizableSidePanel(
    UI_STORAGE_KEYS.ticketDetailPanelWidth,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const controller = useTicketDetailController({
    ticketId,
    projectRootPaths,
    pendingDecision,
    onClose,
    onTicketViewed,
    availableLabels,
    panelRef,
    closeButtonRef,
    commentTextareaRef,
  });

  return (
    <div
      className="overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={`detail-panel resizable-side-panel${detailPanel.isResizing ? ' is-resizing' : ''}${isMaximized ? ' is-maximized' : ''}`}
        style={{ width: isMaximized ? '100%' : `${detailPanel.width}px` }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={controller.onCommentFocusShortcut}
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        tabIndex={-1}
      >
        {/* 最大化中は幅が 100% 固定なのでハンドルは出さない (ChatPanel と同じ) */}
        {!isMaximized && (
          <SidePanelResizeHandle
            label="チケット詳細パネルの幅を変更"
            panel={detailPanel}
          />
        )}
        <TicketDetailHeaderSection
          title={controller.data?.title}
          hasData={controller.data !== undefined}
          isLoading={controller.isLoading}
          titleEditing={controller.title.titleEditing}
          titleDraft={controller.title.titleDraft}
          onTitleDraftChange={controller.title.setTitleDraft}
          canSaveTitle={controller.title.canSaveTitle}
          isSaving={controller.title.isSaving}
          error={controller.title.error}
          onStartTitleEdit={controller.title.handleStartTitleEdit}
          onCancelTitleEdit={controller.title.handleCancelTitleEdit}
          onSaveTitle={controller.title.handleSaveTitle}
          ticketId={ticketId}
          onBackTicket={onBackTicket}
          isMaximized={isMaximized}
          onToggleMaximized={onToggleMaximized}
          onClose={onClose}
          closeButtonRef={closeButtonRef}
        />

        {controller.isLoading && <p className="loading">読み込み中…</p>}
        {controller.error !== null && (
          <p className="error-message">
            {controller.error instanceof Error
              ? controller.error.message
              : '読み込みに失敗しました'}
          </p>
        )}
        {controller.data !== undefined && (
          <>
            <TicketDetailBody
              data={controller.data}
              ticketId={ticketId}
              prLink={prLink}
              onChatAboutTicket={onChatAboutTicket}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
              onFilterByEpic={onFilterByEpic}
              agentRun={controller.agentRun}
              labels={controller.labels}
              inFlightOverlaps={controller.inFlightOverlaps}
              similarTickets={controller.similarTickets}
              description={controller.description}
            />
            <TicketDetailSecondaryBody
              data={controller.data}
              ticketId={ticketId}
              projectRootPath={controller.projectRootPath}
              pendingDecision={pendingDecision}
              isTicketOnBoard={isTicketOnBoard}
              onOpenTicket={onOpenTicket}
              dependencies={controller.dependencies}
              sessionLink={controller.sessionLink}
              decision={controller.decision}
              timeline={controller.timeline}
              comment={controller.comment}
              quickActions={controller.quickActions}
              agentRun={controller.agentRun}
              copy={controller.copy}
              commentTextareaRef={commentTextareaRef}
            />
          </>
        )}
      </div>
    </div>
  );
}
