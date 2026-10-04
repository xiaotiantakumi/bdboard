import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads, type PersistedChatThreadState } from '../../chatThreadStorage';

/**
 * bdboard-0206 / bdboard-rt6i: 「永続化済みのエントリが、サーバー一覧と合わせる前の仮のエントリか」。
 * marked は、このプロジェクトに仮のエントリの印(ProvisionalEntryMarks)が立っているか。persisted はいまのエントリで、
 * 開いているスレッドが 1 件以上ある。エージェント切替(handleAgentChange)の「空に確定」のエントリ
 * (activeSessionIds が空)は利用者の意図なので、これには当たらない。
 */
export function isProvisionalEntry(marked: boolean, persisted: PersistedChatThreadState | undefined): boolean {
  return marked && persisted !== undefined && persisted.activeSessionIds.length > 0;
}

/** bdboard-rt6i: 仮のエントリのとき、利用者が閉じた id を open の候補(サーバー一覧)から外す。 */
export function withoutClosed(threads: readonly ChatThreadDto[], closed: ReadonlySet<string>): readonly ChatThreadDto[] {
  return closed.size === 0 ? threads : threads.filter((thread) => !closed.has(thread.sessionId));
}

/**
 * bdboard-rt6i: プロジェクトごとの「仮のエントリ(provisional entry)」の印と、その間に利用者が閉じたスレッド。
 *
 * 仮のエントリとは、未復元(初回の一覧 fetch が in-flight で、E7 = chat/useThreadListSync.ts が open を
 * まだ復元していない)のプロジェクトで、最初の永続化エントリとして書かれた「いま開いている分だけ」の値。
 * 利用者が開き閉じした記録ではなく、サーバー一覧と合わせる前の暫定値で、復元する側(E7・turn-status 回収の
 * hydrate = chat/recoveredTurnPlan.ts)は、永続化を正本にせずサーバー一覧を足して開く。#852 は E7 のクロージャに
 * 「サイクル開始時にエントリが無かった」を持たせて見分けていたが、それでは回収の hydrate・エージェント切替・
 * 閉じる/削除と区別できなかった。
 *
 * - markIfFirstEntry: 最初の永続化エントリを書く経路(送信成功・採用・履歴ロード・スレッドの選択/再オープン・
 *   選択中スレッドの死亡)が、書く直前に呼ぶ。未復元で、まだエントリが無いときだけ印を立てる。判定は呼ぶ時点の
 *   restoredProjectsRef と永続化を読むので、採用のように restoredProjectsRef を立てる処理より前に呼ぶこと。
 * - isProvisional: 復元する側が読む。印があり、いまのエントリが空でないとき true。
 * - noteClosed / closedIds: 印がある間に利用者が閉じた(削除した)スレッド。閉じる操作は印を下ろさない
 *   (下ろすと、送信 N1 → 送信 N2 → N1 を閉じる、で永続化 [N2] が利用者の記録になり、一度も見ていないサーバーの
 *   スレッドが開かれない)。代わりに閉じた id を覚え、復元する側が開くスレッドから外す(withoutClosed)。
 * - settle: 利用者の明示的な「空」(エージェント切替)と、一覧と合わせた復元(E7 の成功・回収の hydrate)で、
 *   印と閉じた id の両方を下ろす。E7 が取り消し・失敗で着地しなかった場合は呼ばない — 仮のエントリは
 *   仮のまま、次の訪問の復元が(一覧を取れれば)広げる。
 *
 * どこにも永続化しない: チャットパネルを閉じる(AppChatOverlay が ChatPanel をアンマウントする)かリロードで消える。
 */
export interface ProvisionalEntryMarks {
  markIfFirstEntry(projectId: string): void;
  isProvisional(projectId: string, persisted: PersistedChatThreadState | undefined): boolean;
  noteClosed(projectId: string, sessionId: string): void;
  closedIds(projectId: string): ReadonlySet<string>;
  settle(projectId: string): void;
}

const NO_CLOSED: ReadonlySet<string> = new Set();

/** isRestored は restoredProjectsRef 相当(chat/useChatThreadLists.ts)。 */
export function createProvisionalEntryMarks(isRestored: (projectId: string) => boolean): ProvisionalEntryMarks {
  const marked = new Set<string>();
  const closed = new Map<string, Set<string>>();
  return {
    markIfFirstEntry(projectId) {
      if (!isRestored(projectId) && readPersistedChatThreads()[projectId] === undefined) marked.add(projectId);
    },
    isProvisional: (projectId, persisted) => isProvisionalEntry(marked.has(projectId), persisted),
    noteClosed(projectId, sessionId) {
      if (!marked.has(projectId)) return;
      closed.set(projectId, (closed.get(projectId) ?? new Set<string>()).add(sessionId));
    },
    closedIds: (projectId) => closed.get(projectId) ?? NO_CLOSED,
    settle(projectId) {
      marked.delete(projectId);
      closed.delete(projectId);
    },
  };
}
