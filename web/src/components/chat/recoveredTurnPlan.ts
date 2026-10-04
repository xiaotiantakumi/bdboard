import type { ChatThreadDto } from '../../api';
import type { PersistedChatThreadState } from '../../chatThreadStorage';
import { planReplacedThread } from './replacedThread';
import { restoreThreadView } from './threadViewRestore';

export interface RecoveredTurnPlanInput {
  threads: readonly ChatThreadDto[];
  /** 回収したセッション。 */
  sessionId: string;
  /** 回収した返答の元になった送信の会話キー(見届けられなかった sessionId 無しの送信)。不明なら undefined。 */
  origin: string | undefined;
  /** このプロジェクトの open を既に復元済みか(restoredProjectsRef がマーク済みで、open が分かる)。 */
  alreadyRestored: boolean;
  /** live の open(openThreadIdsRef)。 */
  knownOpen: readonly string[] | undefined;
  /** 永続化済みのエントリ。 */
  persisted: PersistedChatThreadState | undefined;
  /**
   * このプロジェクトの永続化済みエントリが仮のエントリか(bdboard-rt6i。provisionalEntryRef が立っていて、
   * エントリに開いているスレッドが 1 件以上ある = threadViewRestore.ts の isFirstVisitWritten)。仮のエントリは
   * 利用者が開き閉じした記録ではないので、永続化を正本にせず、サーバー一覧を足して開く。
   */
  provisionalEntry: boolean;
  /** live の選択(selectedThreadIdsRef)。 */
  knownSelected: string | undefined;
  /** チケット起動のドラフトを表示中で、回収の選択切り替えを抑止するか(bdboard-cemi)。 */
  explicitDraftSelected: boolean;
}

export interface RecoveredTurnPlan {
  nextOpen: string[];
  nextSelected: string | undefined;
  /** 永続化へ書く選択。 */
  persistedSelected: string | undefined;
  /** 回収で置き換えられた開いているスレッドの会話キー(bdboard-w9hv)。 */
  replacedKey: string | undefined;
}

/**
 * chat/useChatSessionLifecycle.ts の applyRecoveredTurn が回収したセッションを足したあとの
 * open と選択を決める部分(bdboard-tsen / bdboard-4w2d / bdboard-cemi の規則はそのまま)。
 *
 * bdboard-w9hv: 回収したセッションが、見届けられなかった sessionId 無しの送信
 * (clearSession 後の再送)の結果で、送信元 origin が開いている実スレッドなら、
 * chat/useChatSendCommits.ts の commitSuccess と同じ規則(chat/replacedThread.ts)で
 * そのスレッドを open から外し、選択やドラフト表示中の永続化済みの選択が origin を指していたら
 * 回収したセッションへ移す。回収したセッションが既に open に居るなら新しく始まったセッション
 * ではないので、origin が残っていても置き換えとして扱わない。
 *
 * bdboard-rt6i: provisionalEntry のとき(初回訪問で、E7 の一覧 fetch が in-flight の間に送信成功・採用が
 * 最初の永続化エントリを書いたあとの回収)は、永続化の仮の [N] を再訪の記録として扱わず、
 * restoreThreadView の firstVisitWritten と同じく全スレッドを開く。復元済み(採用が確立した open)でも
 * サーバー一覧を足す(E7 の同じ場合の widenOpenToServerList と同じ結果。回収が E7 の応答を打ち切るので、
 * ここで足さないと誰も足さない)。
 */
export function planRecoveredTurn(input: RecoveredTurnPlanInput): RecoveredTurnPlan {
  const { threads, sessionId, origin, alreadyRestored, knownOpen, persisted, knownSelected, provisionalEntry } = input;
  const restoresFromList = provisionalEntry || !alreadyRestored;
  const restored = restoresFromList ? restoreThreadView(threads, persisted, provisionalEntry) : undefined;
  // bdboard-4w2d: 復元を行う場合、永続化からの open と、この fetch の in-flight 中に別経路が先に
  // openThreadIds へ書いていた分の両方を残す(和集合)。復元を「永続化からの完全な置き換え」にすると、
  // その racing write を握りつぶしてしまう。
  const currentOpen = restoresFromList
    ? Array.from(new Set([...(restored?.open ?? []), ...(knownOpen ?? [])]))
    : (knownOpen ?? []);
  const { replacedKey, nextOpen } = planReplacedThread({
    convKey: currentOpen.includes(sessionId) ? undefined : origin,
    newSessionId: sessionId,
    open: currentOpen,
    sessionGone: false,
  });
  const movedOff = (id: string | undefined): string | undefined =>
    id !== undefined && id === replacedKey ? undefined : id;
  const nextSelected = input.explicitDraftSelected
    ? undefined
    : (movedOff(knownSelected ?? restored?.selected) ?? sessionId);
  // ドラフト表示中は永続化済みの選択を保つ(bdboard-cemi)。ただし置き換えられたスレッドを指して
  // いたら、もう開いていないので回収したセッションへ移す。
  const persistedBefore = persisted?.selectedSessionId;
  const persistedSelected = input.explicitDraftSelected
    ? (replacedKey !== undefined && persistedBefore === replacedKey ? sessionId : persistedBefore)
    : nextSelected;
  return { nextOpen, nextSelected, persistedSelected, replacedKey };
}
