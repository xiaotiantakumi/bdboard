import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/http';
import type { ExternalIssueListDto } from '../../api/issue-reports-external';
import { makeExternalIssue, makeExternalList } from '../../test/externalIssueFixtures';
import { IssueReportsPanel } from './IssueReportsPanel';

vi.mock('../../api/issue-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports')>();
  return {
    ...actual,
    fetchIssueDrafts: vi.fn(() => Promise.resolve({ drafts: [], pendingCount: 0 })),
    fetchIssueReportPendingCount: vi.fn(() => Promise.resolve({ pendingCount: 0 })),
  };
});
vi.mock('../../api/issue-reports-external', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports-external')>();
  return { ...actual, fetchExternalIssues: vi.fn(), refreshExternalIssues: vi.fn() };
});

import { fetchExternalIssues, refreshExternalIssues } from '../../api/issue-reports-external';

/** bdboard-4y8q.9.5: 不具合報告タブの 4 つ目の切り替え「届いた issue」。 */

const LOCAL = 'localhost';
const REMOTE = 'board.example.test';

function renderPanel(list: ExternalIssueListDto, hostname = LOCAL) {
  vi.mocked(fetchExternalIssues).mockResolvedValue(list);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <IssueReportsPanel hostname={hostname} />
    </QueryClientProvider>,
  );
  return user;
}

async function openExternal(list: ExternalIssueListDto, hostname = LOCAL) {
  const user = renderPanel(list, hostname);
  await user.click(await screen.findByRole('button', { name: /^届いた issue/ }));
  return user;
}

beforeEach(() => {
  vi.mocked(fetchExternalIssues).mockReset();
  vi.mocked(refreshExternalIssues).mockReset();
});

describe('IssueReportsPanel: the incoming issues switch', () => {
  it('does not show the switch when incoming issues are not enabled (not the maintainer environment)', async () => {
    renderPanel(makeExternalList({ enabled: false, issues: [] }));

    await screen.findByRole('button', { name: /^未処理/ });
    await vi.waitFor(() => expect(fetchExternalIssues).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /届いた issue/ })).toBeNull();
  });

  it('shows the switch with the count, opens the cards in place of the drafts, and goes back', async () => {
    const user = await openExternal(
      makeExternalList({ issues: [makeExternalIssue({ number: 17 }), makeExternalIssue({ number: 18, title: 'second issue' })] }),
    );

    const switchButton = screen.getByRole('button', { name: '届いた issue (2)' });
    expect(switchButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^未処理/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('heading', { name: '#17 external example issue' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '#18 second issue' })).toBeTruthy();
    expect(screen.queryByText('未処理の下書きはありません。')).toBeNull();
    expect(document.querySelector('.issue-reports-panel')?.className).toContain('is-external');

    await user.click(screen.getByRole('button', { name: /^未処理/ }));

    expect(screen.getByText('未処理の下書きはありません。')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '#17 external example issue' })).toBeNull();
    expect(screen.getByRole('button', { name: /^未処理/ }).getAttribute('aria-pressed')).toBe('true');
    expect(switchButton.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.issue-reports-panel')?.className).not.toContain('is-external');
  });

  it('keeps the three draft buttons before the switch, in one toggle group', async () => {
    renderPanel(makeExternalList());

    const switchButton = await screen.findByRole('button', { name: /^届いた issue/ });
    expect(switchButton.parentElement).toBe(screen.getByRole('button', { name: /^未処理/ }).parentElement);
  });

  it('draws no body until a card is opened', async () => {
    const user = await openExternal(makeExternalList({ issues: [makeExternalIssue({ body: 'folded body text' })] }));
    expect(screen.queryByText('folded body text')).toBeNull();

    await user.click(screen.getByRole('button', { name: '本文を見る' }));

    expect(screen.getByText('folded body text')).toBeTruthy();
  });
});

describe('IssueReportsPanel: what the incoming issues view says about the check', () => {
  it.each([
    ['gh-missing', 'GitHub CLI (gh) が見つかりません。gh を入れると届いた issue を確かめられます。'],
    ['gh-unauthenticated', 'gh でログインしていません。ターミナルで gh auth login を実行してください。'],
    ['rate-limited', 'GitHub の問い合わせの制限に当たりました。しばらくしてから自動でやり直します。'],
    ['failed', '確認に失敗しました。しばらくしてから自動でやり直します。'],
    ['bd-failed', 'bd の紐付けを読めませんでした。一覧は前回のままです。'],
    ['storage-failed', '写しの保存に失敗しました。一覧は前回のままです。'],
    ['unexpected', '想定外の失敗で確認が止まりました。一覧は前回のままです。'],
    ['a-kind-nobody-knows', '確認が止まりました。'],
  ])('says a fixed sentence for an error of kind %s', async (kind, sentence) => {
    await openExternal(makeExternalList({ state: 'error', fetchedAt: null, issues: [], error: { kind, detail: 'raw detail' } }), REMOTE);

    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it('says "later" without a time when the local gh call budget is used up', async () => {
    await openExternal(
      makeExternalList({
        state: 'error',
        fetchedAt: null,
        issues: [],
        error: { kind: 'failed', detail: 'gh call limit reached: at most 12 gh calls per hour (local limit); try again later' },
      }),
      REMOTE,
    );

    const message = screen.getByText('GitHub への問い合わせの手元の上限に達しました。しばらくしてから確かめられます。');
    expect(message.textContent).not.toMatch(/\d/);
    // detail の文面は、リモートの読み手には出さない。
    expect(document.body.textContent).not.toContain('at most 12');
  });

  it('shows when the list is from, when the check stopped after a good one', async () => {
    await openExternal(makeExternalList({ state: 'error', error: { kind: 'failed', detail: '' } }));

    expect(screen.getByText(/最後に確かめられたのは .+ です \(一覧はそのときのものです\)。/)).toBeTruthy();
    // 止まっていても、前回までのカードは残る。
    expect(screen.getByRole('heading', { name: '#17 external example issue' })).toBeTruthy();
  });

  it('says what an idle, a good and an empty list mean, and the cut-off notes', async () => {
    await openExternal(makeExternalList({ state: 'idle', fetchedAt: null, issues: [], truncated: true, skippedLines: 3 }));

    expect(screen.getByText('まだ確かめていません (起動の約 1 分後に最初の確認をします)。')).toBeTruthy();
    expect(screen.getByText('続きがあります。一覧は上限までです。')).toBeTruthy();
    expect(screen.getByText('GitHub の応答のうち読めなかった行が 3 行あります。')).toBeTruthy();
  });

  it('says there is nothing when the check was good and the list is empty', async () => {
    await openExternal(makeExternalList({ issues: [] }));

    expect(screen.getByText(/届いた issue はありません。/)).toBeTruthy();
  });

  it('shows the error detail to a local reader only', async () => {
    const list = makeExternalList({ state: 'error', error: { kind: 'failed', detail: 'gh: timed out after 20s' } });
    await openExternal(list, LOCAL);
    expect(screen.getByText('詳細: gh: timed out after 20s')).toBeTruthy();
  });

  it('never shows the error detail to a remote (tunnel) reader, only the fixed sentence', async () => {
    const list = makeExternalList({ state: 'error', error: { kind: 'failed', detail: 'gh: timed out after 20s' } });
    await openExternal(list, REMOTE);

    expect(screen.getByText('確認に失敗しました。しばらくしてから自動でやり直します。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('timed out');
    expect(document.body.textContent).not.toContain('詳細:');
  });
});

describe('IssueReportsPanel: "check now"', () => {
  it('is shown to a local reader only', async () => {
    await openExternal(makeExternalList(), REMOTE);
    expect(screen.queryByRole('button', { name: '今すぐ確認' })).toBeNull();
  });

  it('asks the server to check, shows what it answered, and is disabled while it runs', async () => {
    let finish: (list: ExternalIssueListDto) => void = () => undefined;
    vi.mocked(refreshExternalIssues).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = await openExternal(makeExternalList(), LOCAL);

    await user.click(screen.getByRole('button', { name: '今すぐ確認' }));

    expect(screen.getByRole('button', { name: '今すぐ確認' }).disabled).toBe(true);
    expect(screen.getByText('確認しています…')).toBeTruthy();
    finish(makeExternalList({ issues: [makeExternalIssue({ number: 99, title: 'fresh issue' })] }));
    expect(await screen.findByRole('heading', { name: '#99 fresh issue' })).toBeTruthy();
    expect(refreshExternalIssues).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '今すぐ確認' }).disabled).toBe(false);
    // バッジと同じ問い合わせなので、切り替えの件数も新しい一覧に変わる (バッジとの食い違いが出ない)。
    expect(screen.getByRole('button', { name: '届いた issue (1)' })).toBeTruthy();
  });

  it('shows a check that stopped (HTTP 200 with state error) as the list state', async () => {
    vi.mocked(refreshExternalIssues).mockResolvedValue(
      makeExternalList({ state: 'error', error: { kind: 'gh-unauthenticated', detail: 'not logged in' } }),
    );
    const user = await openExternal(makeExternalList(), LOCAL);

    await user.click(screen.getByRole('button', { name: '今すぐ確認' }));

    expect(await screen.findByText('gh でログインしていません。ターミナルで gh auth login を実行してください。')).toBeTruthy();
  });

  it('puts the Retry-After seconds into the sentence when the server refuses with 429', async () => {
    vi.mocked(refreshExternalIssues).mockRejectedValue(
      new ApiError(429, 'refresh is limited to once per minute', {
        body: JSON.stringify({ code: 'refresh-rate-limited', retryAfterSeconds: 42 }),
      }),
    );
    const user = await openExternal(makeExternalList(), LOCAL);

    await user.click(screen.getByRole('button', { name: '今すぐ確認' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('確認は 1 分に 1 回までです。42 秒ほど待ってからもう一度押してください。');
  });

  it('says "later" without a number when a 429 carries no seconds', async () => {
    vi.mocked(refreshExternalIssues).mockRejectedValue(new ApiError(429, 'limited', { body: 'not json' }));
    const user = await openExternal(makeExternalList(), LOCAL);

    await user.click(screen.getByRole('button', { name: '今すぐ確認' }));

    expect((await screen.findByRole('alert')).textContent).toBe('確認は 1 分に 1 回までです。しばらくしてからもう一度押してください。');
  });

  it('shows a fixed sentence, not the server wording, for any other failure', async () => {
    vi.mocked(refreshExternalIssues).mockRejectedValue(new ApiError(500, 'Error: ENOENT /Users/example-user/secret/path'));
    const user = await openExternal(makeExternalList(), LOCAL);

    await user.click(screen.getByRole('button', { name: '今すぐ確認' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('今すぐ確認できませんでした。しばらくしてからもう一度押してください。');
    expect(document.body.textContent).not.toContain('ENOENT');
  });
});

describe('IssueReportsPanel: when the incoming issues cannot be read', () => {
  it('says so in the incoming view without breaking the drafts', async () => {
    vi.mocked(fetchExternalIssues).mockRejectedValue(new ApiError(500, 'boom'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <IssueReportsPanel hostname={LOCAL} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('未処理の下書きはありません。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /届いた issue/ })).toBeNull();
  });
});
