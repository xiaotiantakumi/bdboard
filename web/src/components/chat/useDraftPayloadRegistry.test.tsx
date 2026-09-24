import { act, renderHook } from '@testing-library/react';
import { useCallback, useState, type SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  isEmptyList,
  isEmptyText,
  isNeverEmpty,
  type DraftPayloadStoreTransform,
} from '../conversationKeyspace';
import type { UseChatDraftStateResult } from './useChatDraftState';
import { useDraftPayloadRegistry } from './useDraftPayloadRegistry';

type DraftApplicators = UseChatDraftStateResult['draftApplicators'];

// 4ストア分の applicator を、各ストアの「空」の定義(useChatDraftState.ts と同じ)で
// 手元の Record に transform を当てる形で作る。applicator 自体は1度だけ作って
// 再レンダーをまたいで同じ参照を渡す(useChatDraftState の useCallback と同じ)。
function makeStores() {
  const stores = {
    conversationInputs: {} as Record<string, string>,
    conversationAttachments: {} as Record<string, string[]>,
    attachmentErrors: {} as Record<string, string>,
    draftSeedText: {} as Record<string, string>,
  };
  const calls: string[] = [];
  const applicators: DraftApplicators = {
    conversationInputs: vi.fn((t: DraftPayloadStoreTransform) => {
      calls.push('conversationInputs');
      stores.conversationInputs = t(stores.conversationInputs, isEmptyText);
    }),
    conversationAttachments: vi.fn((t: DraftPayloadStoreTransform) => {
      calls.push('conversationAttachments');
      stores.conversationAttachments = t(stores.conversationAttachments, isEmptyList);
    }),
    attachmentErrors: vi.fn((t: DraftPayloadStoreTransform) => {
      calls.push('attachmentErrors');
      stores.attachmentErrors = t(stores.attachmentErrors, isNeverEmpty);
    }),
    draftSeedText: vi.fn((t: DraftPayloadStoreTransform) => {
      calls.push('draftSeedText');
      stores.draftSeedText = t(stores.draftSeedText, isNeverEmpty);
    }),
  };
  return { stores, calls, applicators };
}

// ChatPanel と同じく、draftApplicators は毎レンダー新しいオブジェクトリテラルで
// 渡し(中の関数は安定)、threadModelIds は本物の useState を使う。
// setThreadModelIds は呼ばれた順番を calls に記録してから本物の setter へ渡す
// (useCallback で安定させる。ChatPanel では useState の setter そのもの)。
function useRegistryProbe(
  applicators: DraftApplicators,
  initialModels: Record<string, string>,
  calls: string[] = [],
) {
  const [threadModelIds, setThreadModelIdsState] = useState(initialModels);
  const setThreadModelIds = useCallback((action: SetStateAction<Record<string, string>>) => {
    calls.push('threadModelIds');
    setThreadModelIdsState(action);
    // 初回レンダーの calls だけを捕まえる。順番を見るテストは calls を明示的に
    // 渡す(テストごとに1つの配列)ので、それで足りる。省略したテストでは
    // 既定値の配列が毎レンダー作られるが、どのテストもそれを読まない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const registry = useDraftPayloadRegistry({
    draftApplicators: { ...applicators },
    setThreadModelIds,
  });
  return { ...registry, threadModelIds };
}

describe('useDraftPayloadRegistry', () => {
  it('keeps all three returned functions referentially stable across re-renders (E6/E9 の依存配列の前提)', () => {
    const { applicators } = makeStores();
    const { result, rerender } = renderHook(() => useRegistryProbe(applicators, {}));
    const first = result.current;

    rerender();
    act(() => {
      first.migrateDraftPayloadKey('new::0', 'new:proj-a:1');
    });
    rerender();

    expect(result.current.applyToDraftPayloadStores).toBe(first.applyToDraftPayloadStores);
    expect(result.current.migrateDraftPayloadKey).toBe(first.migrateDraftPayloadKey);
    expect(result.current.purgeDraftPayloadKeys).toBe(first.purgeDraftPayloadKeys);
  });

  it('recreates the functions when one of the individual applicators changes', () => {
    const { applicators } = makeStores();
    let current = applicators;
    const { result, rerender } = renderHook(() => useRegistryProbe(current, {}));
    const first = result.current;

    current = { ...applicators, attachmentErrors: vi.fn() };
    rerender();

    expect(result.current.applyToDraftPayloadStores).not.toBe(first.applyToDraftPayloadStores);
    expect(result.current.migrateDraftPayloadKey).not.toBe(first.migrateDraftPayloadKey);
    expect(result.current.purgeDraftPayloadKeys).not.toBe(first.purgeDraftPayloadKeys);
  });

  it('applies one transform to all five stores in DRAFT_PAYLOAD_STORE_NAMES order', () => {
    const { calls, applicators } = makeStores();
    const { result } = renderHook(() => useRegistryProbe(applicators, { 'new::0': 'fast' }, calls));
    const seen: string[] = [];

    act(() => {
      result.current.applyToDraftPayloadStores((record) => {
        seen.push(Object.keys(record).join(','));
        return record;
      });
    });

    expect(calls).toEqual([
      'conversationInputs',
      'conversationAttachments',
      'attachmentErrors',
      'threadModelIds',
      'draftSeedText',
    ]);
    // threadModelIds の updater は setState の実行時期(eager か render 時か)に
    // よって順番が前後しうるので、当たった Record の中身だけを見る。
    expect([...seen].sort()).toEqual(['', '', '', '', 'new::0']);
  });

  it('migrates a key in every store with each store’s own emptiness rule', () => {
    const { stores, applicators } = makeStores();
    stores.conversationInputs = { 'new::0': 'draft', 'new:proj-a:1': '' };
    stores.conversationAttachments = { 'new::0': [], 'new:proj-a:1': ['kept'] };
    stores.attachmentErrors = { 'new::0': '' };
    stores.draftSeedText = { 'new::0': 'seed' };
    const { result } = renderHook(() =>
      useRegistryProbe(applicators, { 'new::0': 'quality', 'new:proj-a:1': 'fast' }),
    );

    act(() => {
      result.current.migrateDraftPayloadKey('new::0', 'new:proj-a:1');
    });

    // 本文: 移送先が空文字なので上書きする。
    expect(stores.conversationInputs).toEqual({ 'new:proj-a:1': 'draft' });
    // 添付: 移送元が空配列なので捨てるだけ。移送先は残す。
    expect(stores.conversationAttachments).toEqual({ 'new:proj-a:1': ['kept'] });
    // 添付エラーとシード記録: キーの有無だけが意味を持つ(空文字でも移す)。
    expect(stores.attachmentErrors).toEqual({ 'new:proj-a:1': '' });
    expect(stores.draftSeedText).toEqual({ 'new:proj-a:1': 'seed' });
    // モデル: 移送先に既に値があるので上書きしない。移送元は必ず消える。
    expect(result.current.threadModelIds).toEqual({ 'new:proj-a:1': 'fast' });
  });

  it('purges every matching key from every store and leaves the rest', () => {
    const { stores, applicators } = makeStores();
    stores.conversationInputs = { 'new::0': 'a', 'new::1': 'b', 'sess-1': 'c' };
    stores.conversationAttachments = { 'new::1': ['x'] };
    stores.attachmentErrors = { 'new::0': 'too big' };
    stores.draftSeedText = { 'new::0': 'seed', 'new:proj-a:0': 'seed-a' };
    const { result } = renderHook(() =>
      useRegistryProbe(applicators, { 'new::1': 'fast', 'sess-1': 'quality' }),
    );

    act(() => {
      result.current.purgeDraftPayloadKeys((key) => /^new::/.test(key));
    });

    expect(stores.conversationInputs).toEqual({ 'sess-1': 'c' });
    expect(stores.conversationAttachments).toEqual({});
    expect(stores.attachmentErrors).toEqual({});
    expect(stores.draftSeedText).toEqual({ 'new:proj-a:0': 'seed-a' });
    expect(result.current.threadModelIds).toEqual({ 'sess-1': 'quality' });
  });
});
