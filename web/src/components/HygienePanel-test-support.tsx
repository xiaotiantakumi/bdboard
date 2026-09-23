// bdboard-sso1.85: HygienePanel.test.tsx (2453行) を関心別ファイルへ move-only で
// 分割した際、複数ファイルから使う fixture builder / render ヘルパーだけをここへ
// 出した。単一ファイルからしか使わないもの (makeMergeSlotStatus, NOT_APPLICABLE_CONTRACT,
// COPY_FEEDBACK_MS / REPAIR_FEEDBACK_MS 等) はその消費先ファイルに残している。
// vi.mock はファイル単位でホイストされるため、ここには置かない (各テストファイル側に
// 個別に必要な vi.mock を置く)。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { HygieneIssueDto, HygieneResponseDto, LeaseHealthDto } from '../api';
import { HygienePanel } from './HygienePanel';

export function makeHygieneResponse(
  issues: HygieneIssueDto[] = [],
  closeEvidence: HygieneResponseDto['closeEvidence'] = null,
  nonTicketHarnessWorktrees: HygieneResponseDto['nonTicketHarnessWorktrees'] = [],
): HygieneResponseDto {
  return { issues, closeEvidence, nonTicketHarnessWorktrees };
}

export function makeIssue(
  overrides: Partial<HygieneIssueDto> & Pick<HygieneIssueDto, 'ticketId' | 'kind'>,
): HygieneIssueDto {
  return {
    projectId: 'proj-1',
    message: 'Sample hygiene issue',
    severity: 'warning',
    ...overrides,
  };
}

export function makeLeaseHealth(
  overrides?: Partial<LeaseHealthDto>,
): LeaseHealthDto {
  return {
    staleLeases: [],
    reclaim: {
      enabled: true,
      intervalMs: 300_000,
      olderThan: '10m',
      projects: [],
    },
    ...overrides,
  };
}

export function renderHygienePanel(
  options?: {
    projectIds?: readonly string[];
    onSelectTicket?: (ticketId: string) => void;
    projectRootPaths?: ReadonlyMap<string, string>;
    queryClient?: QueryClient;
  },
) {
  const queryClient =
    options?.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

  const onSelectTicket = options?.onSelectTicket ?? vi.fn();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <HygienePanel
        projectIds={options?.projectIds ?? []}
        onSelectTicket={onSelectTicket}
        projectRootPaths={options?.projectRootPaths}
      />
    </QueryClientProvider>,
  );

  return {
    onSelectTicket,
    container: view.container,
    queryClient,
    unmount: view.unmount,
  };
}

/**
 * spy 済みの window.setTimeout から、指定した遅延で仕掛けられたものだけ数える。
 * React 自身も setTimeout を使うので、素の呼び出し回数では区別できない。
 */
export function timersArmedWith(
  spy: { mock: { calls: readonly unknown[][] } },
  delayMs: number,
): number {
  return spy.mock.calls.filter((call) => call[1] === delayMs).length;
}
