// bdboard-sso1.83 第14c段: useColdKeyspaceAdoption の Probe テスト(設計書 §4a-5)。
// 本物の useConversationKey / useChatConversationsState / useChatDraftState /
// useDraftPayloadRegistry / useChatNotifications と組み合わせ、adopt の判定
// (中身があるか・コールド nonce が進んでいるか)と移送、2つの入口(select と E6)、
// 同じバッチの読み取り方式、E6 の依存配列の前提になる参照安定性を確かめる。
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '../../api';
import type { ChatAttachment } from './attachments';
import { useChatConversationsState } from './useChatConversationsState';
import { useChatDraftState } from './useChatDraftState';
import { useChatNotifications } from './useChatNotifications';
import { useColdKeyspaceAdoption } from './useColdKeyspaceAdoption';
import { useConversationKey } from './useConversationKey';
import { useDraftPayloadRegistry } from './useDraftPayloadRegistry';

const PROJECT_A = { id: 'proj-a', name: 'Project Alpha' } as ProjectDto;
const PROJECT_B = { id: 'proj-b', name: 'Project Beta' } as ProjectDto;

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

interface ProbeProps {
  projects: readonly ProjectDto[];
  initialProjectId?: string;
  ticketContextToken?: number;
}

function useAdoptionProbe({ projects, initialProjectId, ticketContextToken }: ProbeProps) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const key = useConversationKey(selectedProjectId);
  const conv = useChatConversationsState();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const draft = useChatDraftState({
    selectedProjectId,
    currentConversationKey: key.currentConversationKey,
    currentConversationKeyRef: key.currentConversationKeyRef,
    isSending: false,
    inputRef,
    formRef,
  });
  const notifications = useChatNotifications();
  const { migrateDraftPayloadKey } = useDraftPayloadRegistry({
    draftApplicators: draft.draftApplicators,
    setThreadModelIds: conv.setThreadModelIds,
  });
  const adoption = useColdKeyspaceAdoption({
    projects,
    initialProjectId,
    ticketContextToken,
    selectedProjectId,
    setSelectedProjectId,
    draftNoncesRef: key.draftNoncesRef,
    setDraftNonces: key.setDraftNonces,
    conversationInputsRef: draft.conversationInputsRef,
    conversationAttachmentsRef: draft.conversationAttachmentsRef,
    migrateDraftPayloadKey,
    setTicketProjectFallbackNotice: notifications.setTicketProjectFallbackNotice,
  });
  return { selectedProjectId, key, conv, draft, notifications, adoption };
}

function renderProbe(initialProps: ProbeProps = { projects: [PROJECT_A, PROJECT_B] }) {
  return renderHook((props: ProbeProps) => useAdoptionProbe(props), { initialProps });
}

describe('useColdKeyspaceAdoption', () => {
  it('bumps the target nonce and moves the draft when the cold draft has text (r5we)', () => {
    const { result } = renderProbe();
    act(() => {
      result.current.draft.setInput('new::0', '書きかけ');
      result.current.conv.setThreadModelIds({ 'new::0': 'opus' });
    });

    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-a');
    });

    expect(result.current.selectedProjectId).toBe('proj-a');
    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
    expect(result.current.key.currentConversationKey).toBe('new:proj-a:1');
    expect(result.current.draft.conversationInputs).toEqual({ 'new:proj-a:1': '書きかけ' });
    expect(result.current.conv.threadModelIds).toEqual({ 'new:proj-a:1': 'opus' });
  });

  it('bumps for an attachment-only cold draft too, and never trims (major-2)', () => {
    const shot = makeAttachment('shot');
    const { result } = renderProbe();
    act(() => {
      result.current.draft.updateConversationAttachments(() => ({ 'new::0': [shot] }));
    });

    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-a');
    });
    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
    expect(result.current.draft.conversationAttachments).toEqual({ 'new:proj-a:1': [shot] });

    const whitespace = renderProbe();
    act(() => {
      whitespace.result.current.draft.setInput('new::0', '  ');
    });
    act(() => {
      whitespace.result.current.adoption.handleProjectSelectChange('proj-b');
    });
    expect(whitespace.result.current.key.draftNonces).toEqual({ 'proj-b': 1 });
    expect(whitespace.result.current.draft.conversationInputs).toEqual({ 'new:proj-b:1': '  ' });
  });

  it('reads the live cold nonce, carries it over and drops the cold nonce (M1 / ysu SF2)', () => {
    const { result } = renderProbe();
    act(() => {
      result.current.key.setDraftNonces({ '': 2, 'proj-a': 3 });
    });
    act(() => {
      result.current.draft.setInput('new::2', '進んだキーの本文');
    });

    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-a');
    });

    // N1: 1回の adopt で nonce は1つだけ進む('' の残骸は同じ updater で消す)。
    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 4 });
    expect(result.current.draft.conversationInputs).toEqual({ 'new:proj-a:4': '進んだキーの本文' });
  });

  it('bumps on an advanced cold nonce even with an empty draft (ysu SF2)', () => {
    const { result } = renderProbe();
    act(() => {
      result.current.key.setDraftNonces({ '': 1 });
    });

    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-a');
    });

    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
    expect(result.current.key.currentConversationKey).toBe('new:proj-a:1');
  });

  it('does not bump for an empty cold draft whose nonce never moved', () => {
    const { result } = renderProbe();

    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-a');
    });

    expect(result.current.selectedProjectId).toBe('proj-a');
    expect(result.current.key.draftNonces).toEqual({});
    expect(result.current.key.currentConversationKey).toBe('new:proj-a:0');
  });

  it('pins that the content check reads the last rendered inputs while the move reads prev (same batch)', () => {
    // 読み取り方式の棚卸し(§4a-1): coldHasContent は conversationInputsRef(render
    // ミラー)を読むので、同じバッチの入力はまだ見えず bump しない。移送は登録簿の
    // 関数型更新なので、その入力も移る。実際の呼び出し元(select の change と E6)は
    // 入力と同じバッチに入らない。方式は変えていない。
    const { result } = renderProbe();

    act(() => {
      result.current.draft.setInput('new::0', '同じバッチの入力');
      result.current.adoption.handleProjectSelectChange('proj-a');
    });

    expect(result.current.key.draftNonces).toEqual({});
    expect(result.current.draft.conversationInputs).toEqual({ 'new:proj-a:0': '同じバッチの入力' });
  });

  it('pins that a same-batch attachment is seen by the content check (eager ref) and bumps', () => {
    // conversationAttachmentsRef は[eager](dispatch 時点で ref に反映する)。
    // 本文(render ミラー)と違い、同じバッチで積まれた添付は中身の判定に見える。
    const shot = makeAttachment('shot');
    const { result } = renderProbe();

    act(() => {
      result.current.draft.updateConversationAttachments(() => ({ 'new::0': [shot] }));
      result.current.adoption.handleProjectSelectChange('proj-a');
    });

    expect(result.current.key.draftNonces).toEqual({ 'proj-a': 1 });
    expect(result.current.draft.conversationAttachments).toEqual({ 'new:proj-a:1': [shot] });
  });

  it('clears the fallback notice, ignores the empty option and switches directly once a project is chosen', () => {
    const { result } = renderProbe();
    act(() => {
      result.current.notifications.setTicketProjectFallbackNotice('見つかりません');
    });

    act(() => {
      result.current.adoption.handleProjectSelectChange('');
    });
    expect(result.current.notifications.ticketProjectFallbackNotice).toBe('見つかりません');
    expect(result.current.selectedProjectId).toBe('');

    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-a');
    });
    expect(result.current.notifications.ticketProjectFallbackNotice).toBeNull();
    act(() => {
      result.current.draft.setInput('new:proj-a:0', 'A の本文');
    });

    act(() => {
      result.current.notifications.setTicketProjectFallbackNotice('別の通知');
    });
    act(() => {
      result.current.adoption.handleProjectSelectChange('proj-b');
    });
    // 選択済みからの切り替えは adopt しない(A のドラフトは A に残る)。
    expect(result.current.selectedProjectId).toBe('proj-b');
    expect(result.current.notifications.ticketProjectFallbackNotice).toBeNull();
    expect(result.current.draft.conversationInputs).toEqual({ 'new:proj-a:0': 'A の本文' });
    expect(result.current.key.draftNonces).toEqual({});
  });

  it('adopts the resolved project when projects arrive on a regular mount (E6)', () => {
    const { result, rerender } = renderProbe({ projects: [], initialProjectId: 'proj-b' });
    act(() => {
      result.current.draft.setInput('new::0', 'cold');
    });
    expect(result.current.selectedProjectId).toBe('');

    rerender({ projects: [PROJECT_A, PROJECT_B], initialProjectId: 'proj-b' });

    expect(result.current.selectedProjectId).toBe('proj-b');
    expect(result.current.key.draftNonces).toEqual({ 'proj-b': 1 });
    expect(result.current.draft.conversationInputs).toEqual({ 'new:proj-b:1': 'cold' });
  });

  it('leaves E6 idle for a ticket launch, an ambiguous project list, or an already chosen project', () => {
    const ticket = renderProbe({ projects: [], initialProjectId: 'proj-a', ticketContextToken: 1 });
    ticket.rerender({ projects: [PROJECT_A], initialProjectId: 'proj-a', ticketContextToken: 1 });
    expect(ticket.result.current.selectedProjectId).toBe('');

    const ambiguous = renderProbe({ projects: [] });
    ambiguous.rerender({ projects: [PROJECT_A, PROJECT_B] });
    expect(ambiguous.result.current.selectedProjectId).toBe('');

    const chosen = renderProbe({ projects: [PROJECT_A, PROJECT_B] });
    act(() => {
      chosen.result.current.adoption.handleProjectSelectChange('proj-a');
    });
    chosen.rerender({ projects: [PROJECT_A, PROJECT_B], initialProjectId: 'proj-b' });
    expect(chosen.result.current.selectedProjectId).toBe('proj-a');
  });

  it('keeps handleProjectSelectChange stable and does not re-run E6 while typing a cold draft', () => {
    const projects: ProjectDto[] = [];
    const someSpy = vi.spyOn(projects, 'some');
    const { result } = renderProbe({ projects, initialProjectId: 'proj-b' });
    const baseline = someSpy.mock.calls.length;
    expect(baseline).toBeGreaterThan(0);
    const handle = result.current.adoption.handleProjectSelectChange;

    act(() => {
      result.current.draft.setInput('new::0', 'a');
    });
    act(() => {
      result.current.draft.setInput('new::0', 'ab');
    });

    expect(result.current.adoption.handleProjectSelectChange).toBe(handle);
    expect(someSpy.mock.calls.length).toBe(baseline);
  });
});
