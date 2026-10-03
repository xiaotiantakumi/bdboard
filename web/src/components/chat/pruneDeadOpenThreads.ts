import type { ChatThreadDto } from '../../api';
import { resolvePersistedSelectionAfterClose, writePersistedChatThreadState } from '../../chatThreadStorage';
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
 * 付け替える。ただし取り直しが届く前にユーザーが採用したタブを閉じていたら、残った open の先頭へ
 * 付け替える。永続化の書き込みは setState の updater の外で行う(StrictMode の二重実行対策。
 * openThreadIdsRef / selectedThreadIdsRef は useLiveMirroredState なので set の直後に同期済み)。
 *
 * 既知の限界: 1 回目の採用の取り直しが届く前に、基点に入っていて一覧に無い id を 2 回目で採用すると、
 * 1 回目の取り直しがその id を落とす。2 回目の採用にはドロワーの再操作が要り、取り直しはローカルで
 * ms 単位なので、実際にはまず起きない(PR #824 のレビュー)。
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
  const nextOpen = openThreadIdsRef.current[projectId] ?? [];
  const replacement = nextOpen.includes(adoptedSessionId) ? adoptedSessionId : nextOpen[0];
  setSelectedThreadIds((prev) => {
    const current = prev[projectId];
    return current !== undefined && dead.has(current) ? { ...prev, [projectId]: replacement } : prev;
  });
  writePersistedChatThreadState(projectId, {
    activeSessionIds: nextOpen,
    // ライブの選択が無い(ドラフト表示中)ときは、open に残る永続化済みの選択だけを残す(e5cz と同じ規則)。
    selectedSessionId:
      selectedThreadIdsRef.current[projectId] ?? resolvePersistedSelectionAfterClose(projectId, nextOpen, undefined),
  });
}
