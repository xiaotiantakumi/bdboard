import type { ChatThreadDto } from '../../api';

/**
 * bdboard-z9mn: スレッド一覧(threadLists)をサーバーの一覧 fetch の結果で書く処理 —
 * E7(chat/useThreadListSync.ts の初回取得)・採用の取り直し(chat/useChatSessionLifecycle.ts の
 * handleResumeDiscoveredSession)・turn-status 回収の hydrate(applyRecoveredTurn) — を、
 * プロジェクトごとの「fetch 開始順序番号」で一本化する。
 *
 * 以前はこの 3 つがそれぞれ応答が届いた順に無条件で一覧を置き換えていたので、あとから始めた fetch の
 * 一覧が先に届くと、先に始めた(= 古い)fetch の一覧が届いて上書きした。採用したタブが「(無題)」に戻る
 * (採用の取り直し同士・回収と採用の取り直しの前後)、リネームが巻き戻る、といった形で表に出た。
 *
 * 規則:
 * - fetch を始める直前に begin(projectId) で番号を取る(そのプロジェクトで単調に増える)。
 * - 応答が届いたら admit(projectId, seq, fetched) を通す。開始が新しい fetch の一覧が既に当たっていれば
 *   (seq が、いま当たっている番号より小さい)undefined を返す — 呼び出し側は一覧を書かない。そうでなければ
 *   応答を当てた扱いにして(番号を進める)、当ててよい一覧を返す。
 * - fetch ではないローカルの書き込み(リネーム・ピン留めの応答、送信成功で足すエントリ)は
 *   noteEntryWrite で記録する。その書き込みより前に始まった fetch の一覧には、その書き込みの
 *   エントリを重ねて返す(リネームが古いタイトルに戻らない、送信した会話が一覧から落ちない)。
 *   書き込みより後に始まった fetch は、サーバーが書き込みを反映済みなので重ねない。
 *
 * threadListRequestIdRef(chat/useChatConversationsState.ts)とは別物。あちらは「回収が一覧を当てる直前に
 * 進めて、まだ届いていない E7 の応答を捨てる」ための印で、採用で進めると回収の hydrate が
 * recoveredSessionIds から外さずに return して回収が止まる(chat/useTurnStatusRecovery.ts)。
 * この番号は応答を捨てる判断(= 一覧を書くか)にだけ使い、E7 の open・選択の復元や回収の
 * 打ち切りには関わらない。
 */
export interface ThreadListFetchOrder {
  /** プロジェクトの一覧 fetch を始める直前に呼ぶ。そのプロジェクトで単調に増える開始順序番号を返す。 */
  begin(projectId: string): number;
  /**
   * 開始番号 seq の fetch の応答 fetched を一覧へ当ててよいか決める。開始が新しい fetch の一覧が既に
   * 当たっていれば undefined(= 古い一覧。書かない)。そうでなければ、この応答を当てた扱いにして
   * (以後、これより古い番号の応答は undefined になる)、書き込みを重ねた一覧を返す。
   */
  admit(projectId: string, seq: number, fetched: readonly ChatThreadDto[]): ChatThreadDto[] | undefined;
  /**
   * fetch ではないローカルの書き込み(サーバーが返したエントリ、または送信成功で足すエントリ)を記録する。
   * この呼び出しより前に始まった fetch の一覧に対して、admit がこのエントリを重ねる。
   * 'replace' は一覧に同じ id があるときだけ置き換える(リネーム・ピン留め)。'upsert' は無ければ末尾に足す
   * (送信成功で足したエントリ)。
   */
  noteEntryWrite(projectId: string, entry: ChatThreadDto, mode: EntryWriteMode): void;
  /**
   * スレッドをローカルで一覧から落としたとき(削除・死んだセッションの prune)に、そのスレッドの
   * noteEntryWrite の記録を捨てる。残すと、あとから届く古い一覧に「upsert」で蘇らせてしまう。
   * 最後に当てた一覧(appliedList)からも、そのスレッドを落とす。
   */
  forgetEntry(projectId: string, sessionId: string): void;
  /**
   * bdboard-0206: いま当たっている一覧 — admit が最後に返した一覧から、forgetEntry で落としたスレッドを
   * 除いたもの。まだ何も当てていなければ undefined。admit が undefined を返した(応答が古い)呼び出し側が、
   * 古い応答ではなく、当たっている一覧を基にして open を広げるために読む。
   */
  appliedList(projectId: string): readonly ChatThreadDto[] | undefined;
}

export type EntryWriteMode = 'replace' | 'upsert';

interface EntryWrite {
  entry: ChatThreadDto;
  mode: EntryWriteMode;
  /** 書き込んだ時点で払い出し済みだった最大の番号。これ以下の番号の fetch はこの書き込みより前に始まっている。 */
  seq: number;
}

interface ProjectOrder {
  issued: number;
  applied: number;
  writes: Map<string, EntryWrite>;
  /** bdboard-0206: admit が最後に返した一覧(forgetEntry で落とした分を除く)。 */
  appliedList: ChatThreadDto[] | undefined;
}

export function createThreadListFetchOrder(): ThreadListFetchOrder {
  const projects = new Map<string, ProjectOrder>();
  const orderOf = (projectId: string): ProjectOrder => {
    let order = projects.get(projectId);
    if (order === undefined) {
      order = { issued: 0, applied: 0, writes: new Map(), appliedList: undefined };
      projects.set(projectId, order);
    }
    return order;
  };

  return {
    begin(projectId) {
      const order = orderOf(projectId);
      order.issued += 1;
      return order.issued;
    },
    admit(projectId, seq, fetched) {
      const order = orderOf(projectId);
      if (seq < order.applied) return undefined;
      order.applied = seq;
      const merged = [...fetched];
      for (const [sessionId, write] of order.writes) {
        // この fetch はこの書き込みより後に始まっている: サーバーが反映済みなので応答を信じて、記録は要らない。
        if (write.seq < seq) {
          order.writes.delete(sessionId);
          continue;
        }
        const index = merged.findIndex((thread) => thread.sessionId === sessionId);
        if (index >= 0) merged[index] = write.entry;
        else if (write.mode === 'upsert') merged.push(write.entry);
      }
      order.appliedList = merged;
      return merged;
    },
    noteEntryWrite(projectId, entry, mode) {
      const order = orderOf(projectId);
      const previous = order.writes.get(entry.sessionId);
      order.writes.set(entry.sessionId, {
        entry,
        // 先に足したエントリ(upsert)をあとのリネームなどが置き換えても、「一覧に無ければ足す」は保つ。
        mode: previous?.mode === 'upsert' ? 'upsert' : mode,
        seq: order.issued,
      });
    },
    forgetEntry(projectId, sessionId) {
      const order = orderOf(projectId);
      order.writes.delete(sessionId);
      order.appliedList = order.appliedList?.filter((thread) => thread.sessionId !== sessionId);
    },
    appliedList(projectId) {
      return orderOf(projectId).appliedList;
    },
  };
}
