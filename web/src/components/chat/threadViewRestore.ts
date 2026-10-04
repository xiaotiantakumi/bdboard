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
 *
 * bdboard-0206: firstVisitWritten(isFirstVisitWritten が true)のときは、永続化があっても全部開く。
 * その永続化は、E7 が一覧を取りに行っている間に送信成功・採用が書いた最初のエントリで、利用者が
 * 開き閉じした状態ではない。これを正本にすると、サーバー一覧の他のスレッドが開かれない。
 * 永続化の id は一覧に載っていれば全部開く id に含まれるので、サーバー一覧と永続化の和になる。
 */
export function restoreThreadView(
  threads: readonly ChatThreadDto[],
  persisted: PersistedChatThreadState | undefined,
  firstVisitWritten = false,
): RestoredThreadView {
  const available = new Set(threads.map((thread) => thread.sessionId));
  const persistedOpen = (persisted?.activeSessionIds ?? []).filter((id) => available.has(id));
  const open = persisted !== undefined && !firstVisitWritten ? persistedOpen : threads.map((thread) => thread.sessionId);
  const selected =
    persisted?.selectedSessionId && available.has(persisted.selectedSessionId)
      ? persisted.selectedSessionId
      : open[0];
  return { open, selected };
}

/**
 * bdboard-0206: 「初回訪問なのに、一覧の fetch が in-flight の間に最初の永続化エントリが現れた」か。
 * startedWithoutEntry は E7 がその fetch サイクルを始めた時点でエントリが無かったこと、persistedNow は
 * 応答が届いた時点のエントリ。エントリは送信成功(chat/useChatSendCommits.ts の commitSuccess)か
 * CLI セッションの採用(chat/useChatSessionLifecycle.ts の handleResumeDiscoveredSession)が書いたもので、
 * 開いているスレッドが 1 件以上ある。エージェント切替(handleAgentChange)の「空に確定」のエントリ
 * (activeSessionIds が空)は利用者の意図なので、これには当たらない。
 * 開始時にエントリがあった再訪は永続化が利用者の開き閉じの記録なので、当たらない。
 */
export function isFirstVisitWritten(
  startedWithoutEntry: boolean,
  persistedNow: PersistedChatThreadState | undefined,
): boolean {
  return startedWithoutEntry && persistedNow !== undefined && persistedNow.activeSessionIds.length > 0;
}

/**
 * bdboard-0206: 他経路(CLI セッションの採用)が open を確立したあとに初回の一覧が届いた初回訪問で、
 * その open(current)にサーバー一覧のスレッドを足した open。順序はサーバー一覧のまま、一覧に無い
 * current の id(一覧より新しい採用したセッションなど)は末尾に残す。
 */
export function widenOpenToServerList(threads: readonly ChatThreadDto[], current: readonly string[]): string[] {
  const listed = threads.map((thread) => thread.sessionId);
  const known = new Set(listed);
  return [...listed, ...current.filter((id) => !known.has(id))];
}
