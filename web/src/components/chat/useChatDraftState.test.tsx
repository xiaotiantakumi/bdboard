import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useChatDraftState } from './useChatDraftState';

function makeImageFile(name: string, type = 'image/png'): File {
  return new File(['image-bytes'], name, { type });
}

function pasteFiles(target: HTMLElement, files: readonly File[]) {
  fireEvent.paste(target, { clipboardData: { files } });
}

// bdboard-sso1.83 第2段: ChatPanel の該当箇所を模した Probe コンポーネント。
// currentConversationKey は ChatPanel と同じく呼び出し側(ここでは Probe)が
// 所有し、毎レンダー currentConversationKeyRef.current を同期させる(旧
// ChatPanel 759行目付近と同じミラーパターン)。「スレッド切替」は
// selectKey ボタンで conversationKey を変えることで模している。
function Probe() {
  const [conversationKey, setConversationKey] = useState('new::0');
  const [isSending, setIsSending] = useState(false);
  const conversationKeyRef = useRef(conversationKey);
  conversationKeyRef.current = conversationKey;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [submitCount, setSubmitCount] = useState(0);

  const draft = useChatDraftState({
    selectedProjectId: 'proj-1',
    currentConversationKey: conversationKey,
    currentConversationKeyRef: conversationKeyRef,
    isSending,
    inputRef,
    formRef,
  });

  // useThreadDrawerState.test.tsx と同じ参照安定性チェック。呼び出し側
  // (ChatPanel)の useCallback 依存配列に載せている各関数・
  // draftApplicators.* が再レンダーをまたいで安定しているかを記録する。
  const seen = useRef<Record<string, unknown>>({});
  const allMismatchesRef = useRef<string[]>([]);
  const stableEntries: Record<string, unknown> = {
    setInput: draft.setInput,
    updateConversationAttachments: draft.updateConversationAttachments,
    setAttachmentError: draft.setAttachmentError,
    clearAttachmentError: draft.clearAttachmentError,
    applyQuickCommandPrompt: draft.applyQuickCommandPrompt,
    handleComposedEnterSubmit: draft.handleComposedEnterSubmit,
    'draftApplicators.conversationInputs': draft.draftApplicators.conversationInputs,
    'draftApplicators.conversationAttachments': draft.draftApplicators.conversationAttachments,
    'draftApplicators.attachmentErrors': draft.draftApplicators.attachmentErrors,
    'draftApplicators.draftSeedText': draft.draftApplicators.draftSeedText,
  };
  for (const [key, current] of Object.entries(stableEntries)) {
    if (key in seen.current && seen.current[key] !== current) {
      allMismatchesRef.current.push(key);
    }
    seen.current[key] = current;
  }
  const currentValue = draft.conversationInputs[conversationKey] ?? '';
  const currentAttachments = draft.conversationAttachments[conversationKey] ?? [];
  const currentError = draft.attachmentErrors[conversationKey] ?? '';

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitCount((prev) => prev + 1);
      }}
    >
      <p data-testid="identity-mismatches">{allMismatchesRef.current.join(',')}</p>
      <p data-testid="submit-count">{submitCount}</p>
      <p data-testid="conversation-key">{conversationKey}</p>
      <p data-testid="current-value">{currentValue}</p>
      <p data-testid="attachment-count">{currentAttachments.length}</p>
      <p data-testid="attachment-error">{currentError}</p>
      <textarea
        ref={inputRef}
        aria-label="draft-input"
        value={currentValue}
        onChange={(event) => draft.setInput(conversationKey, event.target.value)}
        onPaste={draft.handleImagePaste}
        onKeyDown={draft.handleComposedEnterSubmit}
      />
      <button type="button" onClick={() => setConversationKey('new::1')}>
        switchThread
      </button>
      <button type="button" onClick={() => setConversationKey('new::0')}>
        switchBack
      </button>
      <button type="button" onClick={() => setIsSending((prev) => !prev)}>
        toggleSending
      </button>
      <button
        type="button"
        onClick={() => draft.applyQuickCommandPrompt(conversationKey, 'クイックコマンド文言')}
      >
        quickCommand
      </button>
      {currentAttachments.map((attachment) => (
        <button
          key={attachment.id}
          type="button"
          onClick={() => draft.removeAttachment(conversationKey, attachment.id)}
        >
          remove-{attachment.id}
        </button>
      ))}
    </form>
  );
}

function getInput(): HTMLTextAreaElement {
  return screen.getByLabelText('draft-input') as HTMLTextAreaElement;
}

function click(name: string) {
  act(() => {
    screen.getByRole('button', { name }).click();
  });
}

describe('useChatDraftState (bdboard-sso1.83 第2段)', () => {
  it('starts each conversation key with an empty draft', () => {
    render(<Probe />);
    expect(screen.getByTestId('current-value')).toBeEmptyDOMElement();
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0');
  });

  it('setInput writes per-key and restores the draft when switching back to the original thread (旧: conversationInputs の会話キー別保持)', () => {
    render(<Probe />);
    fireEvent.change(getInput(), { target: { value: '下書きA' } });
    expect(screen.getByTestId('current-value')).toHaveTextContent('下書きA');

    click('switchThread');
    expect(screen.getByTestId('conversation-key')).toHaveTextContent('new::1');
    // 別スレッドの入力欄は空(会話キーごとに独立)
    expect(screen.getByTestId('current-value')).toBeEmptyDOMElement();
    fireEvent.change(getInput(), { target: { value: '下書きB' } });
    expect(screen.getByTestId('current-value')).toHaveTextContent('下書きB');

    click('switchBack');
    expect(screen.getByTestId('conversation-key')).toHaveTextContent('new::0');
    // 元のスレッドに戻すと、そのスレッドで打っていた下書きがそのまま復元される
    expect(screen.getByTestId('current-value')).toHaveTextContent('下書きA');
  });

  it('handleComposedEnterSubmit does not submit while IME composing (旧: handleKeyDown の isImeComposingKeyEvent ガード)', () => {
    render(<Probe />);
    const input = getInput();
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
    expect(screen.getByTestId('submit-count')).toHaveTextContent('0');
  });

  it('handleComposedEnterSubmit submits on Cmd/Ctrl+Enter when not composing', async () => {
    render(<Probe />);
    const user = userEvent.setup();
    // ChatPanel.test.tsx の W3 テストと同じ技法: userEvent の修飾キー付き入力を
    // 使う(他の3件の handleComposedEnterSubmit テストは fireEvent.keyDown で
    // 十分 — 呼ばれないことだけを確認すればよいため)。このテストは
    // requestSubmit() 経由で実際に submit イベントまで辿り着くことを検証する
    // 必要があるので、実ブラウザのキー入力に近い userEvent を使う。
    await user.type(getInput(), '{Meta>}{Enter}{/Meta}');
    expect(screen.getByTestId('submit-count')).toHaveTextContent('1');
  });

  it('handleComposedEnterSubmit ignores plain Enter (no metaKey/ctrlKey)', () => {
    render(<Probe />);
    const input = getInput();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('submit-count')).toHaveTextContent('0');
  });

  it('pasting an image increases the attachment count for the current key (旧: handleImagePaste → ingestImageFiles)', async () => {
    render(<Probe />);
    pasteFiles(getInput(), [makeImageFile('screenshot.png')]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
    });
  });

  it('removeAttachment removes the attachment and clears a lingering error for the same key', async () => {
    render(<Probe />);
    // まず有効な画像を貼り付けて添付を1件作る(エラーは無し)。
    pasteFiles(getInput(), [makeImageFile('a.png')]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
    });
    // 同じキーへ、許可リスト外の MIME を貼り付ける。ここでは既存の添付(a.png)は
    // そのまま残り、バリデーション失敗のエラーだけが上書きで乗る — 現実には
    // 「1枚目は貼れたが2枚目が弾かれた」ケースに相当する。これで「添付は
    // あるがエラーも残っている」という remove-attachment のエラークリアを
    // 検証するのに必要な状態を作れる。
    pasteFiles(getInput(), [makeImageFile('bad.gif', 'image/gif')]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-error')).not.toBeEmptyDOMElement();
    });
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');

    const removeButton = screen.getByRole('button', { name: /^remove-/ });
    act(() => {
      removeButton.click();
    });
    // 添付が消えるだけでなく、同じキーに残っていたエラーも一緒に消える
    // (chatDraftState.ts の attachmentErrorsSlice: remove-attachment は
    // add-attachments と同じくそのキーのエラーを無条件でクリアする)。
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0');
    expect(screen.getByTestId('attachment-error')).toBeEmptyDOMElement();
  });

  it('removeAttachment is a no-op while isSending is true (旧: removeAttachment 冒頭の isSending ガード)', async () => {
    render(<Probe />);
    pasteFiles(getInput(), [makeImageFile('a.png')]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
    });

    click('toggleSending');
    const removeButton = screen.getByRole('button', { name: /^remove-/ });
    act(() => {
      removeButton.click();
    });
    // isSending 中は removeAttachment が何もしない(元実装の `if (isSending) return;`
    // ガードと同じ)ため、添付はそのまま残る。
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');

    click('toggleSending');
    act(() => {
      screen.getByRole('button', { name: /^remove-/ }).click();
    });
    // isSending が false に戻れば通常どおり削除できる。
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0');
  });

  it('pasting an unsupported image subtype sets an attachment error instead of adding an attachment (旧: validateChatAttachments)', async () => {
    render(<Probe />);
    // handleImagePaste 自体は clipboardData.files を type.startsWith('image/') で
    // 先にフィルタする(テキスト等の非画像 paste は素通しでブラウザに委ねる)ので、
    // バリデーション失敗を再現するには「image/ で始まるが許可リスト外」の
    // MIME(GIF)を使う。
    pasteFiles(getInput(), [makeImageFile('doc.gif', 'image/gif')]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-error')).not.toBeEmptyDOMElement();
    });
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0');
  });

  it('applyQuickCommandPrompt writes the prompt into the current key’s draft (旧: handleQuickCommand)', () => {
    render(<Probe />);
    click('quickCommand');
    expect(screen.getByTestId('current-value')).toHaveTextContent('クイックコマンド文言');
  });

  it('keeps setInput/updateConversationAttachments/setAttachmentError/clearAttachmentError/applyQuickCommandPrompt/handleComposedEnterSubmit and all draftApplicators.* referentially stable across re-renders, including a thread switch (react-hooks/exhaustive-deps 対応の前提)', () => {
    // handleImagePaste/handleImageFileChange(→ 内部の ingestImageFiles)は
    // 元実装から引き継いだ意図的な例外: currentConversationKey に依存する
    // クロージャなので、スレッド切替のたびに再生成される(旧実装の
    // ingestImageFiles の依存配列 [currentConversationKey,
    // updateConversationAttachments] と同じ)。そのため参照安定性の
    // 対象からは外している。
    render(<Probe />);
    // state を動かして何度か再レンダーさせる。ChatPanel 側はこれらを
    // useCallback の依存配列に directly 載せている(useChatDraftState.ts
    // のコメント参照) ので、参照が変わると無駄な再生成の温床になる。
    fireEvent.change(getInput(), { target: { value: 'x' } });
    click('switchThread');
    click('switchBack');
    click('quickCommand');
    expect(screen.getByTestId('identity-mismatches')).toBeEmptyDOMElement();
  });
});
