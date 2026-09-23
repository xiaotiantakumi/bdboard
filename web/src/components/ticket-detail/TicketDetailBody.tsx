// bdboard-sso1.5: TicketDetailPanel.tsx の本体JSX(data確定後に並ぶセクション群)の
// 前半を、表示専用コンポーネントとして切り出した。state/effect/query は一切
// 持たず、useTicketDetailController.ts が返すグループ化済みオブジェクトと
// 素通しの props をそのまま各 Section コンポーネントへ配線するだけ
// (JSX・DOM構造・文言は移動前と同一。単純な「ラベル+値」フィールドだけ
// DetailField へ差し替えたが、レンダリング結果の DOM 構造は不変)。
// 後半は TicketDetailSecondaryBody.tsx。
import type { PrBadgeDto, TicketDetailDto } from '../../api';
import { PrLinkBadge } from '../PrLinkBadge';
import { formatDateTime } from './formatters';
import { DetailField } from './DetailField';
import { TicketIdLink } from './TicketIdLink';
import { TicketChildrenSection } from './TicketChildrenSection';
import { TicketInFlightOverlapsSection } from './TicketInFlightOverlapsSection';
import { TicketSimilarTicketsSection } from './TicketSimilarTicketsSection';
import { TicketLabelsSection } from './TicketLabelsSection';
import { TicketDescriptionSection } from './TicketDescriptionSection';
import { MarkdownContent } from '../MarkdownContent';
import {
  TicketAgentRunTrigger,
  TicketAgentRunConfirm,
} from './TicketAgentRunTriggerSection';
import type { useTicketDetailController } from './useTicketDetailController';

type Controller = ReturnType<typeof useTicketDetailController>;

export interface TicketDetailBodyProps {
  data: TicketDetailDto;
  ticketId: string;
  prLink?: PrBadgeDto;
  onChatAboutTicket?: (ctx: { projectId: string; ticketId: string }) => void;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  onFilterByEpic: (ticketId: string) => void;
  agentRun: Controller['agentRun'];
  labels: Controller['labels'];
  inFlightOverlaps: Controller['inFlightOverlaps'];
  similarTickets: Controller['similarTickets'];
  description: Controller['description'];
}

export function TicketDetailBody({
  data,
  ticketId,
  prLink,
  onChatAboutTicket,
  isTicketOnBoard,
  onOpenTicket,
  onFilterByEpic,
  agentRun,
  labels,
  inFlightOverlaps,
  similarTickets,
  description,
}: TicketDetailBodyProps) {
  return (
    <>
      <div className="ticket-action-buttons">
        {onChatAboutTicket !== undefined && (
          <button
            type="button"
            className="btn ticket-chat-btn"
            onClick={() =>
              onChatAboutTicket({
                projectId: data.projectId,
                ticketId: data.id,
              })
            }
          >
            このチケットについてチャット
          </button>
        )}
        <TicketAgentRunTrigger
          agentRunActionsDisabled={agentRun.actionsDisabled}
          runStartDisabled={agentRun.runStartDisabled}
          harnessRunBlockReason={agentRun.harnessRunBlockReason}
          hasActiveRun={agentRun.hasActiveRun}
          onStartConfirm={() => agentRun.setConfirmingAgentRun(true)}
        />
      </div>
      <TicketAgentRunConfirm
        ticketId={ticketId}
        confirmingAgentRun={agentRun.confirmingAgentRun}
        agentRunConfirmRef={agentRun.agentRunConfirmRef}
        cancelAgentRunConfirmRef={agentRun.cancelAgentRunConfirmRef}
        onCancelAgentRun={agentRun.handleCancelAgentRun}
        onStartRun={() => agentRun.startRunMutation.mutate()}
        startRunPending={agentRun.startRunMutation.isPending}
        startRunError={agentRun.startRunMutation.error}
      />
      <DetailField label="ID">{data.id}</DetailField>
      <DetailField label="Status">{data.status}</DetailField>
      <DetailField label="Priority">P{data.priority}</DetailField>
      <DetailField label="Issue Type">{data.issueType}</DetailField>
      {prLink !== undefined && (
        <DetailField label="PR">
          <PrLinkBadge prLink={prLink} />
        </DetailField>
      )}
      {data.assignee !== undefined && (
        <DetailField label="Assignee">{data.assignee}</DetailField>
      )}
      {data.owner !== undefined && (
        <DetailField label="Owner">{data.owner}</DetailField>
      )}
      <TicketLabelsSection
        currentLabels={labels.currentLabels}
        labelInputQuery={labels.labelInputQuery}
        onLabelInputQueryChange={labels.setLabelInputQuery}
        trimmedLabelInput={labels.trimmedLabelInput}
        labelSuggestions={labels.labelSuggestions}
        canSubmitLabel={labels.canSubmitLabel}
        labelMutationPending={labels.labelMutationPending}
        isAddPending={labels.isAddPending}
        error={labels.error}
        onAddLabel={labels.handleAddLabel}
        onRemoveLabel={labels.handleRemoveLabel}
      />
      {data.parentId !== undefined && (
        <DetailField label="Parent ID">
          <TicketIdLink
            id={data.parentId}
            isTicketOnBoard={isTicketOnBoard}
            onOpenTicket={onOpenTicket}
          />
        </DetailField>
      )}
      <TicketChildrenSection
        children={data.children}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
        onFilterByEpic={() => onFilterByEpic(data.id)}
      />
      <TicketInFlightOverlapsSection
        enabled={inFlightOverlaps.inFlightOverlapsEnabled}
        error={inFlightOverlaps.inFlightOverlapsError}
        overlaps={inFlightOverlaps.inFlightOverlaps}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
      />
      <TicketSimilarTicketsSection
        loading={similarTickets.similarTicketsLoading}
        error={similarTickets.similarTicketsError}
        tickets={similarTickets.similarTickets}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
      />
      <DetailField label="Created">{formatDateTime(data.createdAt)}</DetailField>
      <DetailField label="Updated">{formatDateTime(data.updatedAt)}</DetailField>
      {data.startedAt !== undefined && (
        <DetailField label="Started">{formatDateTime(data.startedAt)}</DetailField>
      )}
      {data.closedAt !== undefined && (
        <DetailField label="Closed">{formatDateTime(data.closedAt)}</DetailField>
      )}
      {data.deferUntil !== undefined && (
        <DetailField label="Defer Until">
          {formatDateTime(data.deferUntil)}
        </DetailField>
      )}
      <TicketDescriptionSection
        description={data.description}
        descriptionEditing={description.descriptionEditing}
        descriptionDraft={description.descriptionDraft}
        onDescriptionDraftChange={description.setDescriptionDraft}
        canSaveDescription={description.canSaveDescription}
        isSaving={description.isSaving}
        error={description.error}
        onStartDescriptionEdit={description.handleStartDescriptionEdit}
        onCancelDescriptionEdit={description.handleCancelDescriptionEdit}
        onSaveDescription={description.handleSaveDescription}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={onOpenTicket}
      />
      {data.notes !== undefined && (
        <div className="detail-section">
          <h3>Notes</h3>
          <MarkdownContent
            text={data.notes}
            isTicketOnBoard={isTicketOnBoard}
            onOpenTicket={onOpenTicket}
            className="markdown-detail"
          />
        </div>
      )}
    </>
  );
}
