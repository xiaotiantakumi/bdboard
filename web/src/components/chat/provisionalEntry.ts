import type { ChatThreadDto } from '../../api';
import {
  clearPersistedProvisionalMark,
  readPersistedChatThreads,
  writePersistedProvisionalClosed,
  writePersistedProvisionalMark,
  type PersistedChatThreadState,
} from '../../chatThreadStorage';

/**
 * bdboard-0206 / bdboard-rt6i: 「永続化済みのエントリが、サーバー一覧と合わせる前の仮のエントリか」。
 * marked は、このプロジェクトに仮のエントリの印(ProvisionalEntryMarks)が立っているか。persisted はいまのエントリ。
 * 開いているスレッドが 0 件の空のエントリも、印がある間は仮のエントリのまま: 仮のスレッドを 1 つ閉じて空になった
 * (送信 N1 → N1 を閉じる)ときに、N1 → N2 → N1 を閉じる([A,B,N2])と違ってサーバーのスレッドが開かれない、
 * という不揃いを作らないため。利用者の明示的な「空」(エージェント切替 handleAgentChange)は settle で印ごと下りるので、
 * 空のエントリでも仮にはならない。
 */
export function isProvisionalEntry(marked: boolean, persisted: PersistedChatThreadState | undefined): boolean {
  return marked && persisted !== undefined;
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
 * - isProvisional: 復元する側が読む。印が立っていて、エントリが存在するとき true — 印だけで決まり、印のある [] も仮
 *   (送信 N1 → N1 を閉じる、の [] は利用者の記録ではない)。エージェント切替の空が仮にならないのは、handleAgentChange が
 *   [] を書いた同じハンドラの直後に settle で印を下ろすから(エントリの中身では見分けない)。
 * - noteClosed / noteReopened / closedIds: 印がある間に利用者が閉じた(削除した)スレッド。開き直した(閉じたスレッドの
 *   再オープン、CLI セッションの採用)id は noteReopened で閉じた id から外す。閉じる操作は印を下ろさない
 *   (下ろすと、送信 N1 → 送信 N2 → N1 を閉じる、で永続化 [N2] が利用者の記録になり、一度も見ていないサーバーの
 *   スレッドが開かれない)。代わりに閉じた id を覚え、復元する側が開くスレッドから外す(withoutClosed)。
 * - settle: 利用者の明示的な「空」(エージェント切替)と、一覧と合わせた復元(E7 の成功・回収の hydrate)で、
 *   印と閉じた id の両方を下ろす。E7 が取り消し・失敗で着地しなかった場合は呼ばない — 仮のエントリは
 *   仮のまま、次の訪問の復元が(一覧を取れれば)広げる。
 * - noteListUnavailable: 初回の一覧 fetch が失敗した(E7 の catch)ことを覚える。失敗した E7 は「復元済み」を立てるが、
 *   サーバー一覧とは合わせていない。その後に最初の永続化エントリを書く送信・採用も、未復元と同じく仮のエントリになる
 *   (でないと、一覧が取れなかった訪問で書いた [N] が次の訪問で利用者の記録として読まれ、サーバーのスレッドが開かれない)。
 *   settle で下りる。メモリだけ: restoredProjectsRef 自体がメモリだけで、チャットパネルを閉じれば E7 が最初からやり直す。
 *
 * bdboard-521p: 印と閉じた id は保存エントリにも持たせる(chatThreadStorage.ts の provisional / provisionalClosedSessionIds)。
 * メモリだけだとリロードやチャットパネルを閉じる(AppChatOverlay が ChatPanel をアンマウントする)で消え、E7 が着地しないまま
 * 残った仮の [N] が次の訪問で利用者の記録として読まれていた。動きはこう:
 * - メモリが正で、保存エントリはその写し。プロジェクトを最初に触ったときに、保存エントリの印と閉じた id をメモリへ読み込む
 *   (hydrate。リロード・再マウント後の最初の呼び出しで、前の訪問の印が戻る)。
 * - markIfFirstEntry / noteClosed / noteReopened は保存エントリにも書く。markIfFirstEntry はエントリがまだ無いので、空の
 *   仮のエントリを置き、直後の書き込み(送信成功など)が中身を埋める。印は書き込みが引き継ぐ(chatThreadStorage.ts)。
 * - settle は保存エントリの印と閉じた id も下ろす。下ろすのは settle の呼び出し元(E7 の成功 = 2 経路、回収の hydrate、エージェント切替)だけで、
 *   閉じる・削除は印を下ろさず閉じた id を足す(上記の N1 → N2 → N1 を閉じる、と同じ理由)。
 */
export interface ProvisionalEntryMarks {
  markIfFirstEntry(projectId: string): void;
  isProvisional(projectId: string, persisted: PersistedChatThreadState | undefined): boolean;
  noteClosed(projectId: string, sessionId: string): void;
  noteReopened(projectId: string, sessionId: string): void;
  closedIds(projectId: string): ReadonlySet<string>;
  noteListUnavailable(projectId: string): void;
  settle(projectId: string): void;
}

const NO_CLOSED: ReadonlySet<string> = new Set();

/** isRestored は restoredProjectsRef 相当(chat/useChatThreadLists.ts)。 */
export function createProvisionalEntryMarks(isRestored: (projectId: string) => boolean): ProvisionalEntryMarks {
  const marked = new Set<string>();
  const closed = new Map<string, Set<string>>();
  const listUnavailable = new Set<string>();
  const hydrated = new Set<string>();

  // bdboard-521p: 保存エントリの印と閉じた id を、このマウントがそのプロジェクトを最初に触ったときだけメモリへ読む。
  // 以後はメモリが正(他タブの書き込みは追わない: 印も restoredProjectsRef もタブ内の状態)。
  const hydrate = (projectId: string) => {
    if (hydrated.has(projectId)) return;
    hydrated.add(projectId);
    const entry = readPersistedChatThreads()[projectId];
    if (entry?.provisional !== true) return;
    marked.add(projectId);
    const ids = entry.provisionalClosedSessionIds ?? [];
    if (ids.length > 0) closed.set(projectId, new Set(ids));
  };

  return {
    markIfFirstEntry(projectId) {
      hydrate(projectId);
      const unrestored = !isRestored(projectId) || listUnavailable.has(projectId);
      if (unrestored && readPersistedChatThreads()[projectId] === undefined) {
        marked.add(projectId);
        writePersistedProvisionalMark(projectId);
      }
    },
    isProvisional(projectId, persisted) {
      hydrate(projectId);
      return isProvisionalEntry(marked.has(projectId), persisted);
    },
    noteClosed(projectId, sessionId) {
      hydrate(projectId);
      if (!marked.has(projectId)) return;
      const ids = (closed.get(projectId) ?? new Set<string>()).add(sessionId);
      closed.set(projectId, ids);
      writePersistedProvisionalClosed(projectId, [...ids]);
    },
    noteReopened(projectId, sessionId) {
      hydrate(projectId);
      const ids = closed.get(projectId);
      if (ids === undefined || !ids.delete(sessionId)) return;
      writePersistedProvisionalClosed(projectId, [...ids]);
    },
    closedIds(projectId) {
      hydrate(projectId);
      return closed.get(projectId) ?? NO_CLOSED;
    },
    noteListUnavailable: (projectId) => void listUnavailable.add(projectId),
    settle(projectId) {
      hydrated.add(projectId);
      marked.delete(projectId);
      closed.delete(projectId);
      listUnavailable.delete(projectId);
      clearPersistedProvisionalMark(projectId);
    },
  };
}
