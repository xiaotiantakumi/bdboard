import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type {
  IssueDraftDetailDto,
  IssueDraftDetailResponseDto,
  IssueDraftSummaryDto,
} from '../../api/issue-reports';
import { IssueReportsPanel } from './IssueReportsPanel';

vi.mock('../../api/issue-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports')>();
  return {
    ...actual,
    fetchIssueDrafts: vi.fn(),
    fetchIssueDraft: vi.fn(),
    patchIssueDraft: vi.fn(),
    dismissIssueDraft: vi.fn(),
    fetchIssueReportPendingCount: vi.fn(),
  };
});

import { dismissIssueDraft, fetchIssueDraft, fetchIssueDrafts, patchIssueDraft } from '../../api/issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';

const summary: IssueDraftSummaryDto = {
  id: ID,
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: 'Hook failed in example-project',
  status: 'pending',
  occurrenceCount: 3,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-04T00:00:00.000Z',
  occurredProjectCount: 1,
};

const body = 'Error at /Users/example-user/work/example-project\n\n![pixel](https://attacker.example/p.png)';

const localDraft: IssueDraftDetailDto = {
  ...summary,
  source: 'hook.sh',
  body,
  titleEditedByUser: true,
  bodyEditedByUser: true,
  localOnly: {
    symptomRaw: 'the hook exits 1',
    causeRaw: '',
    preventionRaw: '',
    errorTextRaw: 'RAW-LOG-LINE token=xyz',
    errorTextTruncated: false,
    envInfo: { bdboardVersion: '0.9.0', harnessVersion: '1.2.0', os: 'darwin', nodeVersion: 'v22.14.0' },
  },
  occurredProjects: [
    { name: 'example-project', path: '/Users/example-user/work/example-project', firstSeenAt: summary.firstOccurredAt, lastSeenAt: summary.lastOccurredAt },
  ],
  harnessVersionAtOccurrence: '1.2.0',
  suspectedLeaks: [
    { field: 'body', kind: 'project-path', start: 9, end: 49 },
    { field: 'title', kind: 'a-kind-nobody-knows', start: 15, end: 30 },
  ],
  suspectedLeaksOmitted: 2,
  restricted: false,
};

/** トンネル経由の絞った形: 生ログ・パス・版が無く、直していないので疑いも無い。 */
const restrictedDraft: IssueDraftDetailDto = {
  ...summary,
  body: 'Error at ~/work/example-project',
  titleEditedByUser: false,
  bodyEditedByUser: false,
  localOnly: { errorTextTruncated: false, envInfo: { bdboardVersion: '0.9.0' } },
  occurredProjects: [{ name: 'example-project', firstSeenAt: summary.firstOccurredAt, lastSeenAt: summary.lastOccurredAt }],
  restricted: true,
};

function detail(draft: IssueDraftDetailDto, latestHarnessVersion: string | null = '1.3.0'): IssueDraftDetailResponseDto {
  return { draft, images: [], latestHarnessVersion };
}

async function openDraft(draft: IssueDraftDetailDto, latest?: string | null) {
  vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [summary], pendingCount: 1 });
  vi.mocked(fetchIssueDraft).mockResolvedValue(detail(draft, latest));
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <IssueReportsPanel />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('button', { name: /Hook failed in example-project/ }));
  await screen.findByRole('article', { name: '下書きの中身' });
  return { user, ...view };
}

function apiError(status: number, payload: Record<string, unknown>): ApiError {
  return new ApiError(status, String(payload.error), {
    body: JSON.stringify(payload),
    errorMessage: String(payload.error),
    code: typeof payload.code === 'string' ? payload.code : undefined,
  });
}

describe('IssueReportsPanel (bdboard-4y8q.3.2)', () => {
  beforeEach(() => {
    vi.mocked(fetchIssueDrafts).mockReset();
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(patchIssueDraft).mockReset();
    vi.mocked(dismissIssueDraft).mockReset();
  });

  it('lists pending drafts with kind, projects, count and time, and filters by status', async () => {
    vi.mocked(fetchIssueDrafts).mockResolvedValue({
      drafts: [summary, { ...summary, id: '1-0000000000000000', title: 'Old one', status: 'dismissed', dismissReason: 'dup' }],
      pendingCount: 1,
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IssueReportsPanel />
      </QueryClientProvider>,
    );
    const row = await screen.findByRole('button', { name: /Hook failed in example-project/ });
    expect(row).toHaveTextContent('hook・配布スクリプト');
    expect(row).toHaveTextContent('1 プロジェクト');
    expect(row).toHaveTextContent('3 回');
    expect(screen.queryByText('Old one')).toBeNull();
    await user.click(screen.getByRole('button', { name: '見送り (1)' }));
    expect(screen.getByText('Old one')).toBeInTheDocument();
  });

  it('shows the full local shape: leaks (with an unknown kind), the omitted count, local info and the version gap', async () => {
    const { container } = await openDraft(localDraft);
    const leaks = screen.getByText(/置き換え漏れの疑いがあります/).closest('div') as HTMLElement;
    expect(within(leaks).getByText('プロジェクトのパス')).toBeInTheDocument();
    expect(within(leaks).getByText('その他の疑い (a-kind-nobody-knows)')).toBeInTheDocument();
    expect(within(leaks).getByText('ほかに 2 件の疑いがありますが、上限で省きました。')).toBeInTheDocument();
    // プレビューは画像を読み込まない。
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('safe-preview-image')).toHaveTextContent('https://attacker.example/p.png');
    // 手元の情報 (たたんだ中) にフルパスと生ログ。
    expect(screen.getByText('投稿されない手元の情報').closest('details')).not.toHaveAttribute('open');
    expect(screen.getAllByText('/Users/example-user/work/example-project').length).toBeGreaterThan(0);
    expect(screen.getByText('RAW-LOG-LINE token=xyz')).toBeInTheDocument();
    expect(screen.getByText(/最新の版では直っているかもしれません/)).toBeInTheDocument();
  });

  it('shows the restricted (tunnel) shape without raw logs, paths or leaks, and without a harness version', async () => {
    await openDraft(restrictedDraft, null);
    expect(screen.getByText(/トンネル経由のため、元のエラー本文/)).toBeInTheDocument();
    expect(screen.queryByText(/置き換え漏れの疑いがあります/)).toBeNull();
    expect(screen.queryByText('RAW-LOG-LINE token=xyz')).toBeNull();
    expect(screen.getByText('example-project')).toBeInTheDocument();
    expect(screen.getByText(/発生したときのハーネスの版が記録されていない/)).toBeInTheDocument();
  });

  it('warns when only the omitted marker is present (no positioned leaks)', async () => {
    await openDraft({ ...restrictedDraft, suspectedLeaks: [], suspectedLeaksOmitted: true });
    expect(screen.getByText('ほかにも疑いがありますが、上限で省きました。')).toBeInTheDocument();
    expect(screen.getByText(/トンネル経由では、隠しているパスに当たるかどうかは調べません/)).toBeInTheDocument();
  });

  it.each([
    [apiError(409, { error: 'draft is not pending', status: 'posted' }), /もう未処理ではない.*今の状態: 投稿済み/],
    [apiError(413, { error: 'title or body is too long', code: 'too-long', maxTitleChars: 256, maxBodyChars: 65536 }), /題名は 256 文字、本文は 65536 文字まで/],
    [apiError(413, { error: 'draft would exceed the size limit', code: 'draft-too-large' }), /下書き全体が保存できる大きさを超えます/],
    [apiError(507, { error: 'issue draft storage is full', code: 'storage-full' }), /容量の上限に達している/],
  ])('explains a failed edit (%#) in the user’s words', async (error, expected) => {
    vi.mocked(patchIssueDraft).mockRejectedValue(error);
    const { user } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '直す' }));
    const title = screen.getByRole('textbox', { name: /題名/ });
    await user.clear(title);
    await user.type(title, 'New title');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { title: 'New title' });
  });

  it('says the local error text was trimmed when the save had to shorten it', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...localDraft, body: 'short' }, errorTextTrimmed: true });
    const { user } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '直す' }));
    const bodyBox = screen.getByRole('textbox', { name: /本文/ });
    await user.clear(bodyBox);
    await user.type(bodyBox, 'short');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/手元のエラー本文の末尾を詰めました/)).toBeInTheDocument();
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { body: 'short' });
  });

  it('dismisses a pending draft with a one-line reason', async () => {
    vi.mocked(dismissIssueDraft).mockResolvedValue({ draft: { ...summary, status: 'dismissed', dismissReason: 'not ours' } });
    const { user } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '見送る' }));
    await user.type(screen.getByRole('textbox', { name: '見送る理由 (一言)' }), 'not ours');
    await user.click(screen.getByRole('button', { name: '見送りにする' }));
    expect(await screen.findByText('見送りにしました。')).toBeInTheDocument();
    expect(dismissIssueDraft).toHaveBeenCalledWith(ID, 'not ours');
  });
});
