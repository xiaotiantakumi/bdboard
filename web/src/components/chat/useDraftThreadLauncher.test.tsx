// bdboard-sso1.83 第14b段: useDraftThreadLauncher の Probe テスト(設計書 §4a-5)。
// 同じバッチの退行(ref で最後に描画された値を読み、保留中の関数型更新を取りこぼす)
// は ChatPanel の統合テストでは見えない(userEvent は1操作ごとに flush する)ので、
// 本物の useConversationKey / useChatConversationsState / useChatDraftState と
// 組み合わせたフック単体で、2つの更新を1つの act に入れて確かめる。
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from './attachments';
import { useChatConversationsState } from './useChatConversationsState';
import { useChatDraftState } from './useChatDraftState';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';

function makeAttachment(id: string): ChatAttachment {
  return {
    id,
    file: new File(['image-bytes'], `${id}.png`, { type: 'image/png' }),
    mimeType: 'image/png',
    previewUrl: `blob:${id}`,
    name: `${id}.png`,
    size: 11,
  };
}

function useLauncherProbe(projectId: string) {
  const key = useConversationKey(projectId);
  const conv = useChatConversationsState();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const draft = useChatDraftState({
    selectedProjectId: projectId,
    currentConversationKey: key.currentConversationKey,
    currentConversationKeyRef: key.currentConversationKeyRef,
    isSending: false,
    inputRef,
    formRef,
  });
  const [openThreadIds, setOpenThreadIds] = useState<Record<string, string[]>>({});
  const [selectedAgentId, setSelectedAgentId] = useState('claude');
  const [cancelThreadConfirmDelete] = useState(() => vi.fn());
  const launcher = useDraftThreadLauncher({
    selectedProjectId: projectId,
    ...key,
    ...conv,
    ...draft,
    setOpenThreadIds,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
  });
  return { key, conv, draft, launcher, openThreadIds, selectedAgentId, cancelThreadConfirmDelete };
}

describe('useDraftThreadLauncher', () => {
  it('carries a same-batch pending edit into the new draft on an agent switch (T9: handleAgentChange reads prev)', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    const oldKey = result.current.key.currentConversationKey;
    expect(oldKey).toBe('new:proj-a:0');

    act(() => {
      result.current.draft.setInput(oldKey, 'x');
      result.current.launcher.handleAgentChange('codex');
    });

    expect(result.current.key.currentConversationKey).toBe('new:proj-a:1');
    expect(result.current.draft.conversationInputs['new:proj-a:1']).toBe('x');
    expect(result.current.selectedAgentId).toBe('codex');
    // N1: 1回のトリガーで nonce は1つだけ進む。
    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
  });

  it('moves attachments and copies the seed record on an agent switch (SFX)', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    const shot = makeAttachment('shot');
    act(() => {
      result.current.draft.updateConversationAttachments(() => ({ 'new:proj-a:0': [shot] }));
    });
    result.current.draft.draftSeedTextRef.current['new:proj-a:0'] = 'seed';

    act(() => {
      result.current.launcher.handleAgentChange('codex');
    });

    expect(result.current.draft.conversationAttachments).toEqual({ 'new:proj-a:1': [shot] });
    expect(result.current.draft.draftSeedTextRef.current['new:proj-a:1']).toBe('seed');
  });

  it('consumes a pending prefill into the freshly numbered draft key (MF1/SF1)', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    const shot = makeAttachment('shot');
    result.current.launcher.pendingPrefillRef.current = {
      projectId: 'proj-a',
      text: 'チケット: ',
      modelId: 'opus',
      attachments: [shot],
    };

    act(() => {
      result.current.launcher.startNewDraftThread('proj-a');
    });

    expect(result.current.launcher.pendingPrefillRef.current).toBeNull();
    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
    expect(result.current.draft.conversationInputs['new:proj-a:1']).toBe('チケット: ');
    expect(result.current.draft.conversationAttachments['new:proj-a:1']).toEqual([shot]);
    expect(result.current.draft.draftSeedTextRef.current['new:proj-a:1']).toBe('チケット: ');
    expect(result.current.conv.threadModelIds['new:proj-a:1']).toBe('opus');
    expect(result.current.conv.historyLoadedFor['new:proj-a:1']).toBe(true);
    expect(result.current.cancelThreadConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps an edited previous draft instead of the prefill, and leaves a prefill for another project pending (SF1)', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    act(() => {
      result.current.draft.setInput('new:proj-a:0', '書きかけ');
    });
    result.current.launcher.pendingPrefillRef.current = { projectId: 'proj-b', text: 'B のチケット: ' };

    act(() => {
      result.current.launcher.startNewDraftThread('proj-a');
    });
    // 別プロジェクト宛のプリフィルは消化しない。
    expect(result.current.launcher.pendingPrefillRef.current?.projectId).toBe('proj-b');

    result.current.launcher.pendingPrefillRef.current = { projectId: 'proj-a', text: 'A のチケット: ' };
    act(() => {
      result.current.draft.setInput('new:proj-a:1', '次の書きかけ');
    });
    act(() => {
      result.current.launcher.startNewDraftThread('proj-a');
    });

    expect(result.current.draft.conversationInputs['new:proj-a:2']).toBe('次の書きかけ');
    expect('new:proj-a:2' in result.current.draft.draftSeedTextRef.current).toBe(false);
  });

  it('pins that startNewDraftThread judges the previous draft from the last rendered inputs (render mirror)', () => {
    // 読み取り方式の棚卸し(§4a-1): SF1 の判定は conversationInputsRef(render
    // ミラー)を読む。同じバッチで積まれた入力はまだ見えないので、プリフィルが
    // 新しいキーに入り、その入力は古いキーに残る。実際の呼び出し元(E7/E9 と
    // 「新規スレッド」ボタン)は入力と同じバッチに入らない。方式は変えていない。
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    result.current.launcher.pendingPrefillRef.current = { projectId: 'proj-a', text: 'チケット: ' };

    act(() => {
      result.current.draft.setInput('new:proj-a:0', '同じバッチの入力');
      result.current.launcher.startNewDraftThread('proj-a');
    });

    expect(result.current.draft.conversationInputs['new:proj-a:1']).toBe('チケット: ');
    expect(result.current.draft.conversationInputs['new:proj-a:0']).toBe('同じバッチの入力');
  });

  it('lets an explicit new thread drop pending ticket state and the current attachments (SF5)', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    act(() => {
      result.current.draft.updateConversationAttachments(() => ({ 'new:proj-a:0': [makeAttachment('shot')] }));
      result.current.draft.setAttachmentError('new:proj-a:0', 'too big');
    });
    result.current.launcher.pendingPrefillRef.current = { projectId: 'proj-a', text: 'チケット: ' };
    result.current.launcher.pendingTicketDraftProjectRef.current = 'proj-a';

    act(() => {
      result.current.launcher.handleNewThread();
    });

    expect(result.current.launcher.pendingPrefillRef.current).toBeNull();
    expect(result.current.launcher.pendingTicketDraftProjectRef.current).toBeNull();
    expect(result.current.draft.conversationAttachments).toEqual({});
    expect(result.current.draft.attachmentErrors).toEqual({});
    expect(result.current.key.currentConversationKey).toBe('new:proj-a:1');
    expect(result.current.draft.conversationInputs['new:proj-a:1'] ?? '').toBe('');
    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
  });

  it('advances only the nonce after a dead session and leaves a pending prefill alone (23u)', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    const prefill = { projectId: 'proj-a', text: 'チケット: ' };
    result.current.launcher.pendingPrefillRef.current = prefill;

    act(() => {
      result.current.launcher.advanceDraftNonceAfterSessionGone('proj-a');
    });

    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
    expect(result.current.launcher.pendingPrefillRef.current).toBe(prefill);
    expect(result.current.draft.conversationInputs['new:proj-a:1']).toBeUndefined();
    expect(result.current.cancelThreadConfirmDelete).not.toHaveBeenCalled();
  });

  it('keeps startNewDraftThread and the 23u bump referentially stable while typing', () => {
    const { result } = renderHook(() => useLauncherProbe('proj-a'));
    const first = result.current.launcher;

    act(() => {
      result.current.draft.setInput('new:proj-a:0', 'typing');
    });

    expect(result.current.launcher.startNewDraftThread).toBe(first.startNewDraftThread);
    expect(result.current.launcher.advanceDraftNonceAfterSessionGone).toBe(
      first.advanceDraftNonceAfterSessionGone,
    );
    expect(result.current.launcher.handleAgentChange).toBe(first.handleAgentChange);
    expect(result.current.launcher.pendingPrefillRef).toBe(first.pendingPrefillRef);
    expect(result.current.launcher.pendingTicketDraftProjectRef).toBe(first.pendingTicketDraftProjectRef);
  });
});
