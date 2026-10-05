/**
 * bdboard-mqoa: 編集 (保存・自動の文に戻す) の PATCH に、表示中の下書きの ETag を If-Match で付ける。412 (読んだあとにほかの場所で
 * 変わった) は、最新を読み直す印を付けて利用者の言葉で出し、入力は消さない。保存の応答の ETag は web 側の中身の問い合わせへ置く。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftDetailDto, IssueDraftDetailResponseDto } from '../../api/issue-reports';
import { IssueDraftEditor } from './IssueDraftEditor';
import { DRAFT_CHANGED_ELSEWHERE_HELP } from './issueDraftErrors';

vi.mock('../../api/issue-reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/issue-reports')>()),
  patchIssueDraft: vi.fn(),
}));
import { patchIssueDraft } from '../../api/issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';
const DETAIL_KEY = ['issue-reports', 'detail', ID] as const;
const draft: IssueDraftDetailDto = {
  id: ID,
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: 'My title',
  body: 'My body',
  status: 'pending',
  occurrenceCount: 3,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-04T00:00:00.000Z',
  titleEditedByUser: true,
  bodyEditedByUser: true,
  localOnly: { errorTextTruncated: false, envInfo: {} },
  occurredProjects: [],
  restricted: false,
};

function preconditionFailed(): ApiError {
  const payload = { error: 'draft was changed since it was read', code: 'precondition-failed' };
  return new ApiError(412, payload.error, { body: JSON.stringify(payload), errorMessage: payload.error, code: payload.code });
}

function mount(props: { etag?: string; seeded?: IssueDraftDetailResponseDto } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (props.seeded !== undefined) client.setQueryData(DETAIL_KEY, props.seeded);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const handlers = { onCancel: vi.fn(), onSaved: vi.fn() };
  const view = render(
    <QueryClientProvider client={client}>
      <IssueDraftEditor draft={draft} {...(props.etag !== undefined ? { etag: props.etag } : {})} {...handlers} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client, invalidate, ...handlers, ...view };
}

const titleBox = () => screen.getByRole('textbox', { name: /^題名/ });
const bodyBox = () => screen.getByRole('textbox', { name: /^本文/ });

async function typeTitle(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(titleBox());
  await user.type(titleBox(), text);
}

describe('IssueDraftEditor If-Match (bdboard-mqoa)', () => {
  beforeEach(() => {
    vi.mocked(patchIssueDraft).mockReset();
  });

  it('sends the displayed ETag as If-Match on save', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...draft, title: 'New title' }, errorTextTrimmed: false, etag: '"v2"' });
    const { user, onSaved } = mount({ etag: '"v1"' });
    await typeTitle(user, 'New title');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { title: 'New title' }, { ifMatch: '"v1"' });
  });

  it('sends the displayed ETag as If-Match when putting a field back to the automatic text', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({
      draft: { ...draft, title: 'Auto title', titleEditedByUser: false },
      errorTextTrimmed: false,
      etag: '"v2"',
    });
    const { user } = mount({ etag: '"v1"' });
    await user.click(screen.getByRole('button', { name: '題名を自動の文に戻す' }));
    await user.click(screen.getByRole('button', { name: '捨てて戻す' }));
    await waitFor(() => expect(patchIssueDraft).toHaveBeenCalledWith(ID, { title: '' }, { ifMatch: '"v1"' }));
  });

  it('sends no If-Match when there is no ETag (an older server), so the request is the same as before', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...draft, title: 'New title' }, errorTextTrimmed: false });
    const { user, onSaved } = mount();
    await typeTitle(user, 'New title');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(vi.mocked(patchIssueDraft).mock.calls[0]).toEqual([ID, { title: 'New title' }]);
  });

  describe('a 412 (changed somewhere else since it was read)', () => {
    it('says so in the user’s words, reloads the latest, and keeps what was typed (save)', async () => {
      vi.mocked(patchIssueDraft).mockRejectedValue(preconditionFailed());
      const { user, invalidate, onSaved } = mount({ etag: '"v1"' });
      await typeTitle(user, 'My unsaved title');
      await user.type(bodyBox(), ' and more');
      await user.click(screen.getByRole('button', { name: '保存' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(DRAFT_CHANGED_ELSEWHERE_HELP);
      expect(DRAFT_CHANGED_ELSEWHERE_HELP).toMatch(/ほかの場所で変更されました/);
      expect(DRAFT_CHANGED_ELSEWHERE_HELP).toMatch(/最新の内容を読み込み直しました/);
      // 最新を読み直す印: 中身の問い合わせを無効にして、新しい ETag と中身を取り直させる。
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['issue-reports'] });
      // 入力はそのまま。保存は成功していないので閉じない。
      expect(titleBox()).toHaveValue('My unsaved title');
      expect(bodyBox()).toHaveValue('My body and more');
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    });

    it('says so, reloads and keeps the other field’s unsaved input (put back to the automatic text)', async () => {
      vi.mocked(patchIssueDraft).mockRejectedValue(preconditionFailed());
      const { user, invalidate } = mount({ etag: '"v1"' });
      await user.type(bodyBox(), ' unsaved');
      await user.click(screen.getByRole('button', { name: '題名を自動の文に戻す' }));
      await user.click(screen.getByRole('button', { name: '捨てて戻す' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(DRAFT_CHANGED_ELSEWHERE_HELP);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['issue-reports'] });
      expect(titleBox()).toHaveValue('My title');
      expect(bodyBox()).toHaveValue('My body unsaved');
      expect(screen.queryByText(/自動の文に戻しました/)).toBeNull();
    });

    it('lets the next save go through with the reloaded ETag', async () => {
      vi.mocked(patchIssueDraft).mockRejectedValueOnce(preconditionFailed());
      const { user, rerender, client, onSaved } = mount({ etag: '"v1"' });
      await typeTitle(user, 'Kept title');
      await user.click(screen.getByRole('button', { name: '保存' }));
      await screen.findByRole('alert');
      // 読み直しで新しい ETag と最新の中身 (回数が増えた) が届く。編集欄の入力は置き換わらず、「変わったこと」の知らせが出る。
      rerender(
        <QueryClientProvider client={client}>
          <IssueDraftEditor draft={{ ...draft, occurrenceCount: 4 }} etag='"v3"' onCancel={vi.fn()} onSaved={onSaved} />
        </QueryClientProvider>,
      );
      expect(titleBox()).toHaveValue('Kept title');
      vi.mocked(patchIssueDraft).mockResolvedValueOnce({ draft: { ...draft, title: 'Kept title' }, errorTextTrimmed: false, etag: '"v4"' });
      await user.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(patchIssueDraft).toHaveBeenLastCalledWith(ID, { title: 'Kept title' }, { ifMatch: '"v3"' });
    });

    it('does not mistake other failures for a change elsewhere (a 507 shows its own text and does not reload)', async () => {
      vi.mocked(patchIssueDraft).mockRejectedValue(new ApiError(507, 'issue draft storage is full', { code: 'storage-full' }));
      const { user, invalidate } = mount({ etag: '"v1"' });
      await typeTitle(user, 'New title');
      await user.click(screen.getByRole('button', { name: '保存' }));
      expect(await screen.findByRole('alert')).not.toHaveTextContent(/ほかの場所で変更/);
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['issue-reports'] });
    });
  });

  describe('the ETag in the detail query cache', () => {
    const seeded: IssueDraftDetailResponseDto = { draft, images: [], latestHarnessVersion: '1.3.0', etag: '"v1"' };

    it('replaces it with the ETag of the saved draft and keeps the rest of the cached response', async () => {
      vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...draft, title: 'New title' }, errorTextTrimmed: false, etag: '"v2"' });
      const { user, client, onSaved } = mount({ etag: '"v1"', seeded });
      await typeTitle(user, 'New title');
      await user.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(client.getQueryData(DETAIL_KEY)).toEqual({
        draft: { ...draft, title: 'New title' },
        images: [],
        latestHarnessVersion: '1.3.0',
        etag: '"v2"',
      });
    });

    it('drops the old ETag when the response carries none (a stale one would make the next save a certain 412)', async () => {
      vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...draft, title: 'New title' }, errorTextTrimmed: false });
      const { user, client, onSaved } = mount({ etag: '"v1"', seeded });
      await typeTitle(user, 'New title');
      await user.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const cached = client.getQueryData<IssueDraftDetailResponseDto>(DETAIL_KEY);
      expect(cached?.draft.title).toBe('New title');
      expect(cached !== undefined && 'etag' in cached).toBe(false);
    });
  });
});
