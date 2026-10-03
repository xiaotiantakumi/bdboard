import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import type { UseChatThreadListsResult } from './useChatThreadLists';
import type { UseConversationKeyResult } from './useConversationKey';

export interface PruneDeadOpenThreadsParams
  extends Pick<UseConversationKeyResult, 'selectedThreadIdsRef' | 'setSelectedThreadIds'>,
    Pick<UseChatThreadListsResult, 'openThreadIdsRef' | 'setOpenThreadIds'> {
  projectId: string;
  /** 採用したセッション。サーバー一覧に載る前でも落とさない。 */
  adoptedSessionId: string;
  /** 採用が open の基点にした、サーバー一覧で絞れていない永続化の id。 */
  baseOpenThreads: readonly string[];
  /** 採用の後に取り直したサーバーのスレッド一覧。 */
  threads: readonly ChatThreadDto[];
}

/**
 * bdboard-oaak: セッション採用(chat/useChatSessionLifecycle.ts の handleResumeDiscoveredSession)が、
 * プロジェクトの一覧が未復元のまま永続化の activeSessionIds を open の基点にしたあと、取り直した
 * サーバー一覧に載っていない id を open と永続化から落とす。採用は restoredProjectsRef を立てるので、
 * 後から届く初回の一覧(E7)は open を復元し直さない。ここで落とさないと、サーバーがもう持たない id が
 * タイトルの引けない「(無題)」タブとして残る。復元の経路(chat/threadViewRestore.ts の
 * restoreThreadView)が一覧に無い id を落とすのと同じ規則を、採用の経路にも当てるもの。
 *
 * 落とす対象は baseOpenThreads(採用の基点にした永続化 id)のうち一覧に無いものだけ:
 * 採用したセッション自身は一覧に載る前でも残し、採用の後に別経路(送信成功など)が open へ足した id は、
 * この一覧より新しい可能性があるので触らない。選択が落とした id を指していれば採用したセッションへ
 * 付け替える。永続化の書き込みは setState の updater の外で行う(StrictMode の二重実行対策。
 * openThreadIdsRef / selectedThreadIdsRef は useLiveMirroredState なので set の直後に同期済み)。
 */
export function pruneDeadOpenThreads({
  projectId,
  adoptedSessionId,
  baseOpenThreads,
  threads,
  openThreadIdsRef,
  setOpenThreadIds,
  selectedThreadIdsRef,
  setSelectedThreadIds,
}: PruneDeadOpenThreadsParams): void {
  const listed = new Set(threads.map((thread) => thread.sessionId));
  const dead = new Set(baseOpenThreads.filter((id) => id !== adoptedSessionId && !listed.has(id)));
  if (dead.size === 0) return;
  setOpenThreadIds((prev) => ({
    ...prev,
    [projectId]: (prev[projectId] ?? []).filter((id) => !dead.has(id)),
  }));
  setSelectedThreadIds((prev) => {
    const current = prev[projectId];
    return current !== undefined && dead.has(current) ? { ...prev, [projectId]: adoptedSessionId } : prev;
  });
  const liveSelected = selectedThreadIdsRef.current[projectId];
  const persistedSelected = readPersistedChatThreads()[projectId]?.selectedSessionId;
  writePersistedChatThreadState(projectId, {
    activeSessionIds: openThreadIdsRef.current[projectId] ?? [],
    // ライブの選択が無い(ドラフト表示中)ときは永続化済みの選択を残す。ただし落とした id なら消す。
    selectedSessionId:
      liveSelected ?? (persistedSelected !== undefined && dead.has(persistedSelected) ? undefined : persistedSelected),
  });
}
