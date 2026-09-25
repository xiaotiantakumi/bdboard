// bdboard-sso1.83 第14e段: useTicketContextLaunch(ticket-context effect = 設計書 §1c の E9)の
// Probe テスト。本物の useConversationKey / useChatConversationsState / useChatDraftState /
// useDraftPayloadRegistry / useChatNotifications と組み合わせ、対象プロジェクトの決め方
// (見つかった / 見つからない / 未選択)、S1(projects 未到着)、ドラフトへの切り替え方
// (即時 / pending / プロジェクトを跨ぐ)、コールドウィンドウの引き継ぎと '' キーの掃除、
// 適用済み token のガードと S3、依存配列が [token, projects, purge] だけであることを確かめる。
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '../../api';
import type { ChatAttachment } from './attachments';
import { useChatConversationsState } from './useChatConversationsState';
import { useChatDraftState } from './useChatDraftState';
import { useChatNotifications } from './useChatNotifications';
import { useConversationKey } from './useConversationKey';
import { useDraftPayloadRegistry } from './useDraftPayloadRegistry';
import type { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useTicketContextLaunch } from './useTicketContextLaunch';

const PROJECT_A = { id: 'proj-a', name: 'Project Alpha' } as ProjectDto;
const PROJECT_B = { id: 'proj-b', name: 'Project Beta' } as ProjectDto;
const PREFILL = 'チケット: ';

type PendingPrefill = ReturnType<typeof useDraftThreadLauncher>['pendingPrefillRef']['current'];

interface ProbeProps {
  token: number | undefined;
  projects: readonly ProjectDto[];
  initialProjectId?: string;
  initialInput?: string;
  openThreadIds?: Record<string, string[]>;
}

function makeAttachment(id: string): ChatAttachment {
  return {
    id,
    file: new File(['x'], `${id}.png`, { type: 'image/png' }),
    mimeType: 'image/png',
    previewUrl: `blob:${id}`,
    name: `${id}.png`,
    size: 1,
  };
}

let textarea: HTMLTextAreaElement;
let startNewDraftThread: ReturnType<typeof vi.fn<(projectId: string) => void>>;

function useLaunchProbe(props: ProbeProps & { initialSelected: string }) {
  const [selectedProjectId, setSelectedProjectId] = useState(props.initialSelected);
  const key = useConversationKey(selectedProjectId);
  const conv = useChatConversationsState();
  const inputRef = useRef<HTMLTextAreaElement>(textarea);
  const formRef = useRef<HTMLFormElement>(null);
  const draft = useChatDraftState({
    initialInput: props.initialInput,
    selectedProjectId,
    currentConversationKey: key.currentConversationKey,
    currentConversationKeyRef: key.currentConversationKeyRef,
    isSending: false,
    inputRef,
    formRef,
  });
  const notifications = useChatNotifications();
  const { purgeDraftPayloadKeys } = useDraftPayloadRegistry({
    draftApplicators: draft.draftApplicators,
    setThreadModelIds: conv.setThreadModelIds,
  });
  const pendingPrefillRef = useRef<PendingPrefill>(null);
  const pendingTicketDraftProjectRef = useRef<string | null>(null);
  useTicketContextLaunch({
    ticketContextToken: props.token,
    projects: props.projects,
    initialProjectId: props.initialProjectId,
    initialInput: props.initialInput,
    selectedProjectId,
    setSelectedProjectId,
    inputRef,
    ticketProjectFallbackNotice: notifications.ticketProjectFallbackNotice,
    setTicketProjectFallbackNotice: notifications.setTicketProjectFallbackNotice,
    draftNoncesRef: key.draftNoncesRef,
    conversationInputsRef: draft.conversationInputsRef,
    conversationAttachmentsRef: draft.conversationAttachmentsRef,
    draftSeedTextRef: draft.draftSeedTextRef,
    threadModelIdsRef: conv.threadModelIdsRef,
    purgeDraftPayloadKeys,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    openThreadIds: props.openThreadIds ?? {},
    startNewDraftThread,
  });
  return { selectedProjectId, setSelectedProjectId, key, conv, draft, notifications, pendingPrefillRef, pendingTicketDraftProjectRef };
}

function renderProbe(initialSelected: string, initialProps: ProbeProps) {
  return renderHook((props: ProbeProps) => useLaunchProbe({ ...props, initialSelected }), { initialProps });
}

/** web/src/main.tsx と同じく StrictMode で包む(effect が mount → cleanup → mount と二重に走る)。 */
function renderStrictProbe(initialSelected: string, initialProps: ProbeProps) {
  return renderHook((props: ProbeProps) => useLaunchProbe({ ...props, initialSelected }), {
    initialProps,
    wrapper: StrictMode,
  });
}

async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

describe('useTicketContextLaunch', () => {
  beforeEach(() => {
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    startNewDraftThread = vi.fn<(projectId: string) => void>();
  });

  afterEach(() => {
    textarea.remove();
  });

  it('does nothing without a ticket context token', () => {
    // 選択なし・シード入りのコールドキーで始め、purge も notice も起きないことまで見る。
    const { result } = renderProbe('', {
      token: undefined, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL,
    });
    expect(result.current.pendingPrefillRef.current).toBeNull();
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
    expect(startNewDraftThread).not.toHaveBeenCalled();
    expect(result.current.notifications.ticketProjectFallbackNotice).toBeNull();
    expect(result.current.draft.conversationInputs['new::0']).toBe(PREFILL);
  });

  it('starts the draft at once when the ticket project is selected and its list is loaded, and focuses the prefill end', async () => {
    const { result } = renderProbe('proj-a', {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    });
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    expect(result.current.pendingPrefillRef.current).toEqual({
      projectId: 'proj-a', text: PREFILL, isUserEdit: false, modelId: undefined, attachments: undefined,
    });
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
    expect(result.current.notifications.ticketProjectFallbackNotice).toBeNull();
    textarea.value = PREFILL;
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(PREFILL.length);
  });

  it('leaves a pending ticket draft when the list for the selected project is not loaded yet', () => {
    const { result } = renderProbe('proj-a', { token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL });
    expect(startNewDraftThread).not.toHaveBeenCalled();
    expect(result.current.pendingTicketDraftProjectRef.current).toBe('proj-a');
    expect(result.current.pendingPrefillRef.current?.projectId).toBe('proj-a');
  });

  it('switches to the ticket project through the pending path when it differs from the selected one (MF1)', () => {
    const { result } = renderProbe('proj-a', {
      token: 1, projects: [PROJECT_A, PROJECT_B], initialProjectId: 'proj-b', initialInput: PREFILL, openThreadIds: { 'proj-a': [], 'proj-b': [] },
    });
    expect(result.current.selectedProjectId).toBe('proj-b');
    expect(result.current.pendingTicketDraftProjectRef.current).toBe('proj-b');
    expect(result.current.pendingPrefillRef.current?.projectId).toBe('proj-b');
    expect(startNewDraftThread).not.toHaveBeenCalled();
  });

  it('keeps the selected project and says where it sends when the ticket project is missing (S2)', () => {
    const { result } = renderProbe('proj-a', {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-missing', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    });
    expect(result.current.selectedProjectId).toBe('proj-a');
    expect(result.current.notifications.ticketProjectFallbackNotice).toBe(
      'チケットのプロジェクト(id: proj-missing)が見つからないため、「Project Alpha」で開いています。この内容は「Project Alpha」に対して送信されます。',
    );
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
  });

  it('leaves the project unselected, records nothing and focuses the current text end when the ticket project is missing (r5we)', async () => {
    const { result } = renderProbe('', { token: 1, projects: [PROJECT_A], initialProjectId: 'proj-missing', initialInput: PREFILL });
    expect(result.current.selectedProjectId).toBe('');
    expect(result.current.notifications.ticketProjectFallbackNotice).toBe('チケットのプロジェクト(id: proj-missing)が見つかりません。');
    expect(result.current.pendingPrefillRef.current).toBeNull();
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
    textarea.value = `${PREFILL}abc`;
    textarea.setSelectionRange(0, 0);
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(`${PREFILL}abc`.length);
  });

  it('waits for projects (S1) and applies the token once they arrive', () => {
    const { result, rerender } = renderProbe('', { token: 1, projects: [], initialProjectId: 'proj-a', initialInput: PREFILL });
    expect(result.current.pendingPrefillRef.current).toBeNull();
    expect(result.current.notifications.ticketProjectFallbackNotice).toBeNull();
    rerender({ token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL });
    expect(result.current.selectedProjectId).toBe('proj-a');
    expect(result.current.pendingTicketDraftProjectRef.current).toBe('proj-a');
    expect(result.current.pendingPrefillRef.current).toEqual({
      projectId: 'proj-a', text: PREFILL, isUserEdit: false, modelId: undefined, attachments: undefined,
    });
  });

  it('carries a cold-window edit, model and attachments into the prefill and purges every cold key (104.17)', () => {
    const props: ProbeProps = { token: 1, projects: [], initialProjectId: 'proj-a', initialInput: PREFILL };
    const { result, rerender } = renderProbe('', props);
    act(() => {
      result.current.key.setDraftNonces({ '': 1 });
      result.current.draft.setInput('new::1', 'edited');
      result.current.conv.setThreadModelIds({ 'new::1': 'opus' });
      result.current.draft.updateConversationAttachments(() => ({ 'new::1': [makeAttachment('a1')] }));
    });
    expect(result.current.draft.conversationInputs['new::0']).toBe(PREFILL);

    rerender({ ...props, projects: [PROJECT_A] });

    expect(result.current.pendingPrefillRef.current).toMatchObject({
      projectId: 'proj-a', text: 'edited', isUserEdit: true, modelId: 'opus',
    });
    expect(result.current.pendingPrefillRef.current?.attachments?.map((a) => a.id)).toEqual(['a1']);
    expect(Object.keys(result.current.draft.conversationInputs).filter((k) => k.startsWith('new::'))).toEqual([]);
    expect(Object.keys(result.current.draft.conversationAttachments).filter((k) => k.startsWith('new::'))).toEqual([]);
    expect(Object.keys(result.current.draft.draftSeedTextRef.current).filter((k) => k.startsWith('new::'))).toEqual([]);
    expect(Object.keys(result.current.conv.threadModelIds).filter((k) => k.startsWith('new::'))).toEqual([]);
  });

  it('keeps the ticket prefill when the cold text is still the unedited seed', () => {
    const props: ProbeProps = { token: 1, projects: [], initialProjectId: 'proj-a', initialInput: PREFILL };
    const { result, rerender } = renderProbe('', props);
    rerender({ ...props, projects: [PROJECT_A] });
    expect(result.current.pendingPrefillRef.current).toMatchObject({ text: PREFILL, isUserEdit: false });
  });

  it('does not re-apply an applied token when projects change, but reports that a missing project became available (S3)', () => {
    const props: ProbeProps = {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-b', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    };
    const { result, rerender } = renderProbe('proj-a', props);
    expect(startNewDraftThread).toHaveBeenCalledTimes(1);
    result.current.pendingPrefillRef.current = null;

    rerender({ ...props, projects: [PROJECT_A, PROJECT_B] });

    expect(startNewDraftThread).toHaveBeenCalledTimes(1);
    expect(result.current.pendingPrefillRef.current).toBeNull();
    expect(result.current.selectedProjectId).toBe('proj-a');
    expect(result.current.notifications.ticketProjectFallbackNotice).toBe(
      'チケットのプロジェクト「Project Beta」が利用可能になりました。プロジェクト選択から切り替えられます。',
    );
  });

  it('applies a new token again', () => {
    const props: ProbeProps = {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    };
    const { rerender } = renderProbe('proj-a', props);
    rerender({ ...props, token: 2, initialInput: '次: ' });
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a'], ['proj-a']]);
  });

  it('re-runs only on token, projects or purge changes, not on the values it reads at trigger time', () => {
    // 適用済みの token で notice が出ている間、E9 は実行のたびに S3 の判定で
    // projects.some を呼ぶ。その回数で再実行の有無を見る。
    const projects = [PROJECT_A];
    const someSpy = vi.spyOn(projects, 'some');
    const props: ProbeProps = { token: 1, projects, initialProjectId: 'proj-missing', initialInput: PREFILL };
    const { result, rerender } = renderProbe('', props);
    expect(result.current.notifications.ticketProjectFallbackNotice).not.toBeNull();
    const baseline = someSpy.mock.calls.length;

    act(() => { result.current.setSelectedProjectId('proj-a'); });
    rerender({ ...props, initialInput: 'changed', openThreadIds: { 'proj-a': ['sess-1'] }, initialProjectId: 'proj-a' });
    act(() => { result.current.draft.setInput('new::0', 'typing'); });
    expect(someSpy.mock.calls.length).toBe(baseline);

    rerender({ ...props, initialProjectId: 'proj-a', projects: [PROJECT_A] });
    expect(result.current.notifications.ticketProjectFallbackNotice).toBe(
      'チケットのプロジェクト「Project Alpha」が利用可能になりました。プロジェクト選択から切り替えられます。',
    );
  });
});

// bdboard-jlts: StrictMode の二重実行では、1回目の effect が予約した rAF の focus を cleanup が
// 取り消し、2回目は「この token は適用済み」で早期 return していたため、開発ビルドでは入力欄に
// フォーカスが当たらなかった。focus の予約は cleanup を越えて持ち越し、適用済みの経路でも
// まだ当てていなければ予約し直す。
describe('useTicketContextLaunch focus under StrictMode (bdboard-jlts)', () => {
  beforeEach(() => {
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    startNewDraftThread = vi.fn<(projectId: string) => void>();
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: 片付けの前にアンマウントする。
    try {
      cleanup();
    } finally {
      textarea.remove();
    }
  });

  it('focuses the prefill end and starts the draft only once when the list is loaded', async () => {
    renderStrictProbe('proj-a', {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    });
    // N1: 二重実行でもドラフトは1回だけ起こす(2回目は適用済みで早期 return)。
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    textarea.value = PREFILL;
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(PREFILL.length);
  });

  it('focuses the textarea on the pending path while the list is not loaded yet', async () => {
    const { result } = renderStrictProbe('proj-a', { token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL });
    expect(result.current.pendingTicketDraftProjectRef.current).toBe('proj-a');
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
  });

  it('focuses the textarea when the launch switches to another project (MF1)', async () => {
    const { result } = renderStrictProbe('proj-a', {
      token: 1, projects: [PROJECT_A, PROJECT_B], initialProjectId: 'proj-b', initialInput: PREFILL, openThreadIds: { 'proj-a': [], 'proj-b': [] },
    });
    expect(result.current.selectedProjectId).toBe('proj-b');
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
  });

  it('focuses the current text end when the ticket project is missing and nothing is selected (r5we)', async () => {
    renderStrictProbe('', { token: 1, projects: [PROJECT_A], initialProjectId: 'proj-missing', initialInput: PREFILL });
    textarea.value = `${PREFILL}abc`;
    textarea.setSelectionRange(0, 0);
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(`${PREFILL}abc`.length);
  });

  it('does not focus again once the reserved focus has run, even when projects change later', async () => {
    const props: ProbeProps = {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    };
    const { rerender } = renderStrictProbe('proj-a', props);
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
    textarea.blur();

    // 適用済みの token のまま projects だけが変わる(S3 の経路)。
    rerender({ ...props, projects: [PROJECT_A, PROJECT_B] });
    await flushFrame();
    expect(document.activeElement).not.toBe(textarea);
  });

  it('does not focus after an unmount before the frame (N5)', async () => {
    const { unmount } = renderStrictProbe('proj-a', {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    });
    unmount();
    await flushFrame();
    expect(document.activeElement).not.toBe(textarea);
  });

  it('still focuses when projects change before the reserved frame runs (without StrictMode)', async () => {
    // StrictMode でなくても、focus の前に projects が変わって effect が張り直されると、同じ
    // 取り消しが起きていた。
    const props: ProbeProps = {
      token: 1, projects: [PROJECT_A], initialProjectId: 'proj-a', initialInput: PREFILL, openThreadIds: { 'proj-a': [] },
    };
    const { rerender } = renderProbe('proj-a', props);
    rerender({ ...props, projects: [PROJECT_A, PROJECT_B] });
    textarea.value = PREFILL;
    await flushFrame();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(PREFILL.length);
    expect(startNewDraftThread).toHaveBeenCalledTimes(1);
  });
});
