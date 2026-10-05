/**
 * PR #884 レビュー (bdboard-4y8q.3.2) の指摘を固定するテスト: トンネルでの添付画像 (MAJOR-1)、安全の判定 (M3/M4/M18)、
 * 状態 (保存・見送り後の読み直し、pending 以外の操作)、深い入れ子 (R2)、裏の読み直しで入力が消えない (R3)。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type {
  IssueDraftDetailDto,
  IssueDraftDetailResponseDto,
  IssueDraftImageDto,
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
  };
});

import { dismissIssueDraft, fetchIssueDraft, fetchIssueDrafts, patchIssueDraft } from '../../api/issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';
const summary: IssueDraftSummaryDto = {
  id: ID,
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: 'Hook failed',
  status: 'pending',
  occurrenceCount: 9,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-04T00:00:00.000Z',
  occurredProjectCount: 1,
};
const localDraft: IssueDraftDetailDto = {
  ...summary,
  body: 'body',
  titleEditedByUser: false,
  bodyEditedByUser: false,
  localOnly: { errorTextTruncated: false, envInfo: {} },
  occurredProjects: [{ name: 'example-project', firstSeenAt: summary.firstOccurredAt, lastSeenAt: summary.lastOccurredAt }],
  restricted: false,
};
const restrictedDraft: IssueDraftDetailDto = { ...localDraft, restricted: true };

function image(fileName: string, url: string): IssueDraftImageDto {
  return { fileName, url, byteLength: 2048, createdAt: '2026-10-04T00:00:00.000Z' };
}

async function openDraft(
  draft: IssueDraftDetailDto,
  images: readonly IssueDraftImageDto[] = [],
  latestHarnessVersion: string | null = null,
) {
  const response: IssueDraftDetailResponseDto = { draft, images: [...images], latestHarnessVersion };
  vi.mocked(fetchIssueDrafts).mockResolvedValue({ drafts: [{ ...summary, status: draft.status }], pendingCount: 1 });
  vi.mocked(fetchIssueDraft).mockResolvedValue(response);
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <IssueReportsPanel />
    </QueryClientProvider>,
  );
  if (draft.status !== 'pending') {
    const toggle = draft.status === 'posted' ? /^投稿済み \(/ : /^見送り \(/;
    await user.click(await screen.findByRole('button', { name: toggle }));
  }
  await user.click(await screen.findByRole('button', { name: /Hook failed/ }));
  await screen.findByRole('article', { name: '下書きの中身' });
  return { user, client, ...view };
}

const OWN_IMAGE_URL = `/api/issue-reports/drafts/${ID}/images/a.png`;

describe('IssueReportsPanel review fixes (bdboard-4y8q.3.2)', () => {
  beforeEach(() => {
    vi.mocked(fetchIssueDrafts).mockReset();
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(patchIssueDraft).mockReset();
    vi.mocked(dismissIssueDraft).mockReset();
  });

  it('links only this bdboard’s own image URLs on the local screen (M3)', async () => {
    const { container } = await openDraft(localDraft, [
      image('a.png', OWN_IMAGE_URL),
      image('b.png', 'https://evil.example/x.png'),
      image('c.png', '/api/other/c.png'),
    ]);
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([OWN_IMAGE_URL]);
    expect(screen.getByText('b.png').tagName).toBe('SPAN');
    expect(screen.getByText('c.png').tagName).toBe('SPAN');
  });

  it('shows attached images as names only through the tunnel and says they cannot be opened (MAJOR-1)', async () => {
    const { container } = await openDraft(restrictedDraft, [image('a.png', OWN_IMAGE_URL)]);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('a.png').tagName).toBe('SPAN');
    expect(screen.getByText(/添付画像は開けません/)).toBeInTheDocument();
  });

  it('never renders raw local text through the tunnel, even if the response carried it (M4)', async () => {
    await openDraft({
      ...restrictedDraft,
      localOnly: { errorTextRaw: 'RAW-LOG-SECRET', symptomRaw: 'RAW-SYMPTOM', errorTextHead: 'HEAD-SECRET', errorTextTruncated: false, envInfo: {} },
    });
    expect(screen.queryByText(/RAW-LOG-SECRET|RAW-SYMPTOM|HEAD-SECRET/)).toBeNull();
  });

  it('says the tunnel does not check paths even when there are no suspected leaks (NIT-4)', async () => {
    await openDraft(restrictedDraft);
    expect(screen.getByText(/トンネル経由では、隠しているパスに当たるかどうかは調べません/)).toBeInTheDocument();
  });

  it.each([
    ['javascript:alert(1)', null],
    ['https://evil.example/issues/5', null],
    ['https://github.com/example/repo/issues/5', 'https://github.com/example/repo/issues/5'],
  ])('links the posted issue URL %s only when it is on github.com (M18)', async (issueUrl, expected) => {
    const { container } = await openDraft({ ...localDraft, status: 'posted', issueUrl, issueNumber: 5 });
    expect(container.querySelector('a')?.getAttribute('href') ?? null).toBe(expected);
  });

  it('offers neither editing nor dismissing for a draft that is no longer pending (M15/M19)', async () => {
    await openDraft({ ...localDraft, status: 'dismissed', dismissReason: 'dup' });
    expect(screen.getByText('見送りの理由: dup')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '直す' })).toBeNull();
    expect(screen.queryByRole('button', { name: '見送る' })).toBeNull();
  });

  it('puts the saved draft into the detail at once and reloads the list after saving (M10/M11)', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...localDraft, title: 'Saved title' }, errorTextTrimmed: false });
    const { user } = await openDraft(localDraft);
    // 保存後の読み直しは返らないままにする: 中身に出る題名は、保存の応答で置き換えた値でしかありえない。
    vi.mocked(fetchIssueDraft).mockImplementation(() => new Promise(() => {}));
    const listCalls = vi.mocked(fetchIssueDrafts).mock.calls.length;
    await user.click(screen.getByRole('button', { name: '直す' }));
    const title = screen.getByRole('textbox', { name: /題名/ });
    await user.clear(title);
    await user.type(title, 'Saved title');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('Saved title')).toBeInTheDocument();
    expect(vi.mocked(fetchIssueDrafts).mock.calls.length).toBeGreaterThan(listCalls);
  });

  it('refuses an over-long title on the client without calling the API (M17)', async () => {
    const { user } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '直す' }));
    fireEvent.change(screen.getByRole('textbox', { name: /題名/ }), { target: { value: 'x'.repeat(257) } });
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText(/長すぎて保存できません/)).toBeInTheDocument();
    expect(patchIssueDraft).not.toHaveBeenCalled();
  });

  it('asks for a reason before dismissing, and reloads the list after dismissing (M12/M25)', async () => {
    vi.mocked(dismissIssueDraft).mockResolvedValue({ draft: { ...summary, status: 'dismissed', dismissReason: 'dup' } });
    const { user } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '見送る' }));
    await user.click(screen.getByRole('button', { name: '見送りにする' }));
    expect(screen.getByText('見送る理由を一言書いてください。')).toBeInTheDocument();
    expect(dismissIssueDraft).not.toHaveBeenCalled();
    const listCalls = vi.mocked(fetchIssueDrafts).mock.calls.length;
    await user.type(screen.getByRole('textbox', { name: '見送る理由 (一言)' }), 'dup');
    await user.click(screen.getByRole('button', { name: '見送りにする' }));
    expect(await screen.findByText('見送りにしました。')).toBeInTheDocument();
    expect(vi.mocked(fetchIssueDrafts).mock.calls.length).toBeGreaterThan(listCalls);
  });

  it('keeps a deeply nested draft openable and dismissable (R2)', async () => {
    await openDraft({ ...localDraft, body: '> '.repeat(2000) + 'x' });
    expect(screen.getByTestId('safe-preview-fallback')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '見送る' })).toBeInTheDocument();
  });

  it('keeps unsaved edits when the draft is reloaded underneath, and says so (R3)', async () => {
    const { user, client } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '直す' }));
    const bodyBox = screen.getByRole('textbox', { name: /本文/ });
    await user.type(bodyBox, ' my unsaved edit');
    act(() => {
      client.setQueryData<IssueDraftDetailResponseDto>(['issue-reports', 'detail', ID], (previous) =>
        previous === undefined ? previous : { ...previous, draft: { ...previous.draft, title: 'Rebuilt', body: 'body!', occurrenceCount: 10 } },
      );
    });
    await screen.findByText('10 回');
    expect(screen.getByRole('textbox', { name: /本文/ })).toHaveValue('body my unsaved edit');
    expect(screen.getByText(/編集中に、この下書きが裏で更新されました \(いま 10 回\)/)).toBeInTheDocument();
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: localDraft, errorTextTrimmed: false });
    await user.click(screen.getByRole('button', { name: '保存' }));
    // 触っていない題名は送らない (裏で作り直された題名を古い値で上書きしない)。
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { body: 'body my unsaved edit' });
  });

  it('polls the list at the same interval as the badge and clears the selection when the status changes (MINOR-4/NIT-7)', async () => {
    const { user, client } = await openDraft(localDraft);
    expect(client.getQueryCache().find({ queryKey: ['issue-reports', 'list'] })?.options).toMatchObject({ refetchInterval: 60_000 });
    await user.click(screen.getByRole('button', { name: /^見送り \(/ }));
    expect(screen.queryByRole('article', { name: '下書きの中身' })).toBeNull();
  });

  it('explains a 409 from another screen, closes the editor and shows the unsaved input to copy (re-review MINOR-A, N8/N9)', async () => {
    const { user } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '直す' }));
    await user.type(screen.getByRole('textbox', { name: /^本文/ }), ' a long careful edit');
    // 別の画面で見送られた: PATCH は 409、読み直すと dismissed。
    vi.mocked(fetchIssueDraft).mockResolvedValue({
      draft: { ...localDraft, status: 'dismissed', dismissReason: 'dup' },
      images: [],
      latestHarnessVersion: null,
    });
    vi.mocked(patchIssueDraft).mockRejectedValue(
      new ApiError(409, 'draft is not pending', {
        body: JSON.stringify({ error: 'draft is not pending', status: 'dismissed' }),
        errorMessage: 'draft is not pending',
      }),
    );
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(
      await screen.findByText(/別の画面で「見送り」になっていたので、編集を閉じました。入力していた内容は保存していません/),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '入力していた本文' })).toHaveValue('body a long careful edit');
    expect(screen.queryByRole('textbox', { name: /^本文/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '直す' })).toBeNull();
  });

  it('explains a close by a background reload even without unsaved input, until another view is chosen (re-review MINOR-A)', async () => {
    const { user, client } = await openDraft(localDraft);
    await user.click(screen.getByRole('button', { name: '直す' }));
    act(() => {
      client.setQueryData<IssueDraftDetailResponseDto>(['issue-reports', 'detail', ID], (previous) =>
        previous === undefined ? previous : { ...previous, draft: { ...previous.draft, status: 'posted' } },
      );
    });
    expect(await screen.findByText('別の画面で「投稿済み」になっていたので、編集を閉じました。')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '入力していた本文' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'プレビュー' }));
    expect(screen.queryByText(/編集を閉じました/)).toBeNull();
  });

  it('prefers the version recorded at occurrence over the one in the env info (re-review NIT-R4, M20)', async () => {
    await openDraft(
      { ...localDraft, harnessVersionAtOccurrence: '1.3.0', localOnly: { errorTextTruncated: false, envInfo: { harnessVersion: '1.0.0' } } },
      [],
      '1.3.0',
    );
    expect(screen.getByText(/最新の版で起きています/)).toBeInTheDocument();
  });
});
