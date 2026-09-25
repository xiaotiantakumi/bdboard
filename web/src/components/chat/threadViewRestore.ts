import type { ChatThreadDto } from '../../api';
import type { PersistedChatThreadState } from '../../chatThreadStorage';

export interface RestoredThreadView {
  open: string[];
  selected: string | undefined;
}

/**
 * bdboard-tsen: プロジェクトの「開いているスレッドと選択」を、サーバーの一覧と永続化済みの
 * 状態から復元する規則。スレッド一覧 effect(E7、chat/useThreadListSync.ts)が初回の一覧を
 * 受け取ったときに使う。turn-status 回収の hydrate(applyRecoveredTurn、
 * chat/useChatSessionLifecycle.ts)も、E7 がまだそのプロジェクトを復元していない間に当たる
 * ときは、同じ規則で復元してから回収したセッションを足す(E7 の応答はその後に届いても
 * 一覧・open・選択を当てない)。
 * - 永続化があれば、そのうちサーバーがまだ一覧に載せている id だけを開く。無ければ全部開く。
 * - 選択は永続化済みの選択が一覧にあればそれ、無ければ開いた先頭。
 */
export function restoreThreadView(
  threads: readonly ChatThreadDto[],
  persisted: PersistedChatThreadState | undefined,
): RestoredThreadView {
  const available = new Set(threads.map((thread) => thread.sessionId));
  const persistedOpen = (persisted?.activeSessionIds ?? []).filter((id) => available.has(id));
  const open = persisted !== undefined ? persistedOpen : threads.map((thread) => thread.sessionId);
  const selected =
    persisted?.selectedSessionId && available.has(persisted.selectedSessionId)
      ? persisted.selectedSessionId
      : open[0];
  return { open, selected };
}
