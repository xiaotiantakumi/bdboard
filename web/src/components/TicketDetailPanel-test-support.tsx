// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) を関心別ファイルへ move-only で
// 分割した際、複数ファイルから使う fixture / render ヘルパーだけをここへ出した。単一
// ファイルからしか使わないもの (defaultTicketDecisionOutcome, rerenderPanel,
// renderPanelWithUndoSnackbar 等) はその消費先ファイルに残している。vi.mock はファイル
// 単位でホイストされるため、ここには置かない (各テストファイル側に個別に必要な
// vi.mock を置く)。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { useState } from 'react';
import type {
  PendingDecisionDto,
  PrBadgeDto,
  ProjectHarnessContractDto,
  ProjectHarnessPackStatusDto,
  ProjectHarnessStatusDto,
  TicketDetailDto,
} from '../api';
import { TicketDetailPanel, type TicketDetailPanelProps } from './TicketDetailPanel';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

const OK_HARNESS_CONTRACT: ProjectHarnessContractDto = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
  models: null,
  expiredExcludeCount: 0,
  modelExclusionWarnings: [],
};

/** エージェント実行の前提を満たしたハーネス状態 (bdboard-pkr6.11)。 */
export function harnessStatus(
  packOverrides: Partial<ProjectHarnessPackStatusDto> = {},
  contract: ProjectHarnessContractDto = OK_HARNESS_CONTRACT,
): ProjectHarnessStatusDto {
  return {
    packs: [
      {
        name: 'bdboard-harness',
        availableVersion: '1.0.0',
        installedVersion: '1.0.0',
        drift: false,
        hooksState: 'ok',
        missingHooks: [],
        ...packOverrides,
      },
    ],
    contract,
  };
}

export const sampleTicket: TicketDetailDto = {
  id: 'bdboard-abc.1',
  projectId: 'proj-1',
  title: 'Sample ticket',
  status: 'open',
  priority: 2,
  issueType: 'task',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  dependencies: [],
  blockedBy: [],
  blocks: [],
  commentCount: 0,
  sessionLinks: [],
  models: [],
  children: [],
};

/*
 * 最大化 state は App 側が持つ (bdboard-0hcx / PR#242 opus レビュー major-1)。
 * パネル単体テストでは、その App の役割をこの薄いラッパで代行する。
 */
export function MaximizablePanel(
  props: Omit<TicketDetailPanelProps, 'isMaximized' | 'onToggleMaximized'>,
) {
  const [maximized, setMaximized] = useState(false);
  return (
    <TicketDetailPanel
      {...props}
      isMaximized={maximized}
      onToggleMaximized={() => setMaximized((value) => !value)}
    />
  );
}

export function renderPanel(
  projectRootPaths: ReadonlyMap<string, string>,
  pendingDecision?: PendingDecisionDto,
  prLink?: PrBadgeDto,
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  }),
  availableLabels: string[] = [],
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WatchedTicketsProvider>
        <MaximizablePanel
          ticketId={sampleTicket.id}
          projectRootPaths={projectRootPaths}
          pendingDecision={pendingDecision}
          prLink={prLink}
          onClose={() => {}}
          onChatAboutTicket={() => {}}
          onOpenTicket={() => {}}
          isTicketOnBoard={() => true}
          onFilterByEpic={() => {}}
          availableLabels={availableLabels}
        />
      </WatchedTicketsProvider>
    </QueryClientProvider>,
  );

  return { ...view, queryClient };
}
