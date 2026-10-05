/**
 * bdboard-494n: 「直した」印の付いた欄を、編集欄から自動の文へ戻す。#889 (pnvj) より前に '' と「直した」印で保存された題名・本文は、
 * 編集欄が初めから空で、保存しても何も送らず (changedFields は空)、画面から戻せなかった。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftDetailDto } from '../../api/issue-reports';
import { IssueDraftEditor } from './IssueDraftEditor';

vi.mock('../../api/issue-reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/issue-reports')>()),
  patchIssueDraft: vi.fn(),
}));
import { patchIssueDraft } from '../../api/issue-reports';

const ID = '1758812345678-a1b2c3d4e5f6a7b8';
const AUTO_TITLE = 'Hook failed in example-project';
const AUTO_BODY = '種類: hook\n発生回数: 3';
const automatic: IssueDraftDetailDto = {
  id: ID,
  kind: 'B',
  fingerprint: 'B:hook.sh:abcd',
  title: AUTO_TITLE,
  body: AUTO_BODY,
  status: 'pending',
  occurrenceCount: 3,
  firstOccurredAt: '2026-10-01T00:00:00.000Z',
  lastOccurredAt: '2026-10-04T00:00:00.000Z',
  titleEditedByUser: false,
  bodyEditedByUser: false,
  localOnly: { errorTextTruncated: false, envInfo: {} },
  occurredProjects: [],
  restricted: false,
};
/** #889 より前に '' と「直した」印で保存された形 (編集欄は初めから空)。 */
const legacy: IssueDraftDetailDto = { ...automatic, title: '', body: '', titleEditedByUser: true, bodyEditedByUser: true };
const handEdited: IssueDraftDetailDto = { ...automatic, title: 'My title', body: 'My body', titleEditedByUser: true, bodyEditedByUser: true };

function mount(draft: IssueDraftDetailDto, handlers: { onCancel?: () => void; onSaved?: () => void; onInputChange?: (input: unknown) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { onCancel: vi.fn(), onSaved: vi.fn(), onInputChange: vi.fn(), ...handlers };
  const view = render(
    <QueryClientProvider client={client}>
      <IssueDraftEditor draft={draft} {...props} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client, props, ...view };
}

const titleBox = () => screen.getByRole('textbox', { name: /^題名/ });
const bodyBox = () => screen.getByRole('textbox', { name: /^本文/ });
const resetButton = (field: '題名' | '本文') => screen.getByRole('button', { name: `${field}を自動の文に戻す` });
const queryResetButton = (field: '題名' | '本文') => screen.queryByRole('button', { name: `${field}を自動の文に戻す` });

describe('IssueDraftEditor automatic text reset (bdboard-494n)', () => {
  // 波括弧で書く: 式のまま返すと mock 自身が beforeEach の「後始末」として呼ばれ、残した実装 (mockRejectedValue) が余計に走る。
  beforeEach(() => {
    vi.mocked(patchIssueDraft).mockReset();
  });

  it.each([
    ['neither field was edited', false, false, [], ['題名', '本文']],
    ['only the title was edited', true, false, ['題名'], ['本文']],
    ['only the body was edited', false, true, ['本文'], ['題名']],
    ['both fields were edited', true, true, ['題名', '本文'], []],
  ] as const)('offers the reset button only for an edited field: %s', (_name, titleEdited, bodyEdited, shown, hidden) => {
    mount({ ...automatic, titleEditedByUser: titleEdited, bodyEditedByUser: bodyEdited });
    for (const field of shown) expect(resetButton(field)).toBeInTheDocument();
    for (const field of hidden) expect(queryResetButton(field)).toBeNull();
  });

  it('puts back a body that was saved empty with the edited mark, which saving cannot send (the case this ticket fixes)', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...legacy, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: false });
    const { user, props } = mount(legacy);
    expect(bodyBox()).toHaveValue('');
    // 保存では戻せない: 欄が初めから空なので、変えた欄が無く何も送らずに閉じる。
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(patchIssueDraft).not.toHaveBeenCalled();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    // 戻すボタンは差分に関係なく、本文だけを空にした PATCH を送る。捨てる内容が無いので確認は挟まない。
    await user.click(resetButton('本文'));
    await waitFor(() => expect(patchIssueDraft).toHaveBeenCalledTimes(1));
    expect(patchIssueDraft).toHaveBeenCalledWith(ID, { body: '' });
    expect(screen.queryByRole('button', { name: '捨てて戻す' })).toBeNull();
  });

  it('puts back a title that was saved empty, sending only the title', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...legacy, title: AUTO_TITLE, titleEditedByUser: false }, errorTextTrimmed: false });
    const { user } = mount(legacy);
    await user.click(resetButton('題名'));
    await waitFor(() => expect(patchIssueDraft).toHaveBeenCalledWith(ID, { title: '' }));
    expect(patchIssueDraft).toHaveBeenCalledTimes(1);
  });

  it('treats a field with only whitespace as having nothing to lose, so it is put back without asking', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: automatic, errorTextTrimmed: false });
    const { user } = mount({ ...legacy, body: ' \n ' });
    await user.click(resetButton('本文'));
    await waitFor(() => expect(patchIssueDraft).toHaveBeenCalledWith(ID, { body: '' }));
  });

  it('shows the automatic text and a status after the reset, keeps the other field’s unsaved input, and does not resend the restored text on save', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...legacy, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: false });
    const { user, props } = mount({ ...legacy, title: 'My title' });
    await user.type(titleBox(), ' typed');
    await user.click(resetButton('本文'));
    await waitFor(() => expect(bodyBox()).toHaveValue(AUTO_BODY));
    expect(screen.getByText('本文を自動の文に戻しました。')).toBeInTheDocument();
    // 戻していない題名の、保存していない入力は残る。入力の報告は、題名だけが開始時と違う形になる。
    expect(titleBox()).toHaveValue('My title typed');
    expect(props.onInputChange).toHaveBeenLastCalledWith({ title: 'My title typed', body: AUTO_BODY });
    // 編集欄は開いたまま (閉じて入力を捨てない)。
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    // 戻した本文は「編集を始めたときの値」になったので、保存では題名だけが送られる (自動の文を「直した」文として送らない)。
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...legacy, title: 'My title typed', body: AUTO_BODY }, errorTextTrimmed: false });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchIssueDraft).toHaveBeenCalledTimes(2));
    expect(patchIssueDraft).toHaveBeenLastCalledWith(ID, { title: 'My title typed' });
  });

  it('reports no unsaved input once the reset field was the only difference', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...handEdited, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: false });
    const { user, props } = mount(handEdited);
    await user.type(bodyBox(), ' more');
    expect(props.onInputChange).toHaveBeenLastCalledWith({ title: 'My title', body: 'My body more' });
    await user.click(resetButton('本文'));
    await user.click(await screen.findByRole('button', { name: '捨てて戻す' }));
    await waitFor(() => expect(bodyBox()).toHaveValue(AUTO_BODY));
    expect(props.onInputChange).toHaveBeenLastCalledWith(null);
  });

  it('says when saving to the limit shortened the local error text', async () => {
    vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...legacy, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: true });
    const { user } = mount(legacy);
    await user.click(resetButton('本文'));
    expect(await screen.findByText(/本文を自動の文に戻しました。保存の上限に収めるため、手元のエラー本文の末尾を詰めました/)).toBeInTheDocument();
  });

  describe('when there is something to lose', () => {
    it('asks first for a hand-edited text, sending nothing until it is confirmed', async () => {
      vi.mocked(patchIssueDraft).mockResolvedValue({ draft: { ...handEdited, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: false });
      const { user } = mount(handEdited);
      await user.click(resetButton('本文'));
      expect(screen.getByText('今の本文は捨てて、自動で組んだ内容に戻します。')).toBeInTheDocument();
      expect(patchIssueDraft).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '捨てて戻す' }));
      await waitFor(() => expect(patchIssueDraft).toHaveBeenCalledWith(ID, { body: '' }));
      await waitFor(() => expect(bodyBox()).toHaveValue(AUTO_BODY));
      // 題名は触っていないので、そのまま。
      expect(titleBox()).toHaveValue('My title');
      expect(screen.queryByRole('button', { name: '捨てて戻す' })).toBeNull();
    });

    it('moves focus to the safe choice, and cancelling sends nothing and keeps the text and the button', async () => {
      const { user } = mount(handEdited);
      await user.click(resetButton('題名'));
      expect(screen.getByRole('button', { name: '戻すのをやめる' })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: '戻すのをやめる' }));
      expect(patchIssueDraft).not.toHaveBeenCalled();
      expect(screen.queryByText(/捨てて、自動で組んだ内容に戻します/)).toBeNull();
      expect(titleBox()).toHaveValue('My title');
      expect(resetButton('題名')).toHaveFocus();
    });

    it('asks as well when the saved text is empty but there is an unsaved input to lose', async () => {
      const { user } = mount(legacy);
      await user.type(bodyBox(), 'half-written');
      await user.click(resetButton('本文'));
      expect(screen.getByRole('button', { name: '捨てて戻す' })).toBeInTheDocument();
      expect(patchIssueDraft).not.toHaveBeenCalled();
    });
  });

  describe('when the reset fails', () => {
    it('explains a 409 from another screen, keeps the input and the button, and re-reads the draft', async () => {
      vi.mocked(patchIssueDraft).mockRejectedValue(
        new ApiError(409, 'draft is not pending', { body: JSON.stringify({ error: 'draft is not pending', status: 'dismissed' }), errorMessage: 'draft is not pending' }),
      );
      const { user, client } = mount(legacy);
      // 別の画面で状態が変わったので、中身の問い合わせを古い扱いにして読み直させる (「直す」の有無を今の状態に合わせる)。
      client.setQueryData(['issue-reports', 'detail', ID], { draft: legacy });
      await user.type(titleBox(), 'kept');
      await user.click(resetButton('本文'));
      expect(await screen.findByRole('alert')).toHaveTextContent('この下書きはもう未処理ではないため、変更できません (今の状態: 見送り)');
      expect(titleBox()).toHaveValue('kept');
      expect(bodyBox()).toHaveValue('');
      expect(resetButton('本文')).toBeEnabled();
      expect(screen.queryByText(/自動の文に戻しました/)).toBeNull();
      expect(client.getQueryState(['issue-reports', 'detail', ID])?.isInvalidated).toBe(true);
    });

    it('shows a generic message for an unexpected failure, and can be tried again', async () => {
      vi.mocked(patchIssueDraft).mockRejectedValueOnce(new Error('boom'));
      vi.mocked(patchIssueDraft).mockResolvedValueOnce({ draft: { ...legacy, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: false });
      const { user } = mount(legacy);
      await user.click(resetButton('本文'));
      expect(await screen.findByRole('alert')).toHaveTextContent('保存できませんでした。');
      await user.click(resetButton('本文'));
      await waitFor(() => expect(bodyBox()).toHaveValue(AUTO_BODY));
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('disables the buttons and keeps the inputs read-only while the reset is in flight', async () => {
    let finish: (value: { draft: IssueDraftDetailDto; errorTextTrimmed: boolean }) => void = () => {};
    vi.mocked(patchIssueDraft).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { user } = mount(legacy);
    await user.click(resetButton('本文'));
    expect(resetButton('題名')).toBeDisabled();
    expect(resetButton('本文')).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'やめる' })).toBeDisabled();
    expect(titleBox()).toHaveAttribute('readonly');
    expect(bodyBox()).toHaveAttribute('readonly');
    finish({ draft: { ...legacy, body: AUTO_BODY, bodyEditedByUser: false }, errorTextTrimmed: false });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled());
    expect(bodyBox()).not.toHaveAttribute('readonly');
  });
});
