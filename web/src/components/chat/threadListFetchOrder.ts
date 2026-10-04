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
 * - 応答が届いたら admit(projectId, seq, fetched) を通す。1 つの seq につき 1 回だけ。開始が新しい fetch の
 *   一覧が既に当たっていれば(seq が、いま当たっている番号以下 — 同じ seq の 2 回目を含む)undefined を返す —
 *   呼び出し側は一覧を書かない。そうでなければ応答を当てた扱いにして(番号を進める)、当ててよい一覧を返す。
 * - fetch ではないローカルの書き込み(リネーム・ピン留めの応答、送信成功で足すエントリ)は
 *   noteEntryWrite で記録する。その書き込みより前に始まった fetch の一覧には、その書き込みの
 *   エントリを重ねて返す(リネームが古いタイトルに戻らない、送信した会話が一覧から落ちない)。
 *   書き込みより後に始まった fetch は、サーバーが書き込みを反映済みなので重ねない。
 * - スレッドを削除した(forgetEntry)ときは、削除より前に始まった fetch の一覧からそのスレッドを除く
 *   (bdboard-gtv0。削除前に始まった一覧取得が遅れて着いて、閉じた一覧に削除済みのスレッドが戻らない)。
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
   * 開始番号 seq の fetch の応答 fetched を一覧へ当ててよいか決める。1 つの seq につき 1 回だけ呼ぶ
   * (2 回目は stale として捨てる)。開始が新しい fetch の一覧が既に当たっていれば undefined(= 古い一覧。
   * 書かない)。そうでなければ、この応答を当てた扱いにして(以後、この番号以下の応答は undefined になる)、
   * 削除したスレッドを除き、書き込みを重ねた一覧を返す。
   * forgetEntry の「applied < issued のときだけ記録」と、記録を捨てる条件(forgottenAt <= seq)は、
   * 同じ seq が 2 度当たらないこと(= この <= の判定)を前提にしている。
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
   * bdboard-gtv0: さらに、まだ届いていない fetch があるなら(applied < issued)削除の記録(いま払い出し済みの
   * 最大の番号)を残す。削除より前に始まった fetch の一覧が遅れて届いても、admit がそのスレッドを一覧から除く。
   * 削除より後に始まった fetch の一覧は、サーバーが削除を反映済みなのでそのまま当てる。
   * 削除のあとで同じスレッドを noteEntryWrite('upsert')した分は、削除より新しい手元の事実なので、
   * 削除前に始まった fetch の一覧にも重なる(admit は削除の除去を書き込みの重ね合わせより先に行う)。
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
  /**
   * bdboard-gtv0: forgetEntry で落としたスレッドの削除記録(sessionId → 削除した時点で払い出し済みだった最大の番号)。
   * この番号以下の fetch は削除より前に始まっていて、応答にそのスレッドが入っていても一覧へ戻さない。
   * admit が、番号が削除点以上の fetch を当てたとき(削除点ちょうどの fetch も、削除より前に始まっている。
   * 以後それ以下の番号の応答はすべて stale として捨てられる)に捨てる。
   */
  forgotten: Map<string, number>;
}

export function createThreadListFetchOrder(): ThreadListFetchOrder {
  const projects = new Map<string, ProjectOrder>();
  const orderOf = (projectId: string): ProjectOrder => {
    let order = projects.get(projectId);
    if (order === undefined) {
      order = { issued: 0, applied: 0, writes: new Map(), appliedList: undefined, forgotten: new Map() };
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
      // 1 つの seq につき 1 回だけ(同じ seq の 2 回目は stale)。forgetEntry の applied < issued と、下の
      // forgottenAt <= seq での記録の破棄は、この <= の判定(同じ seq が 2 度当たらないこと)を前提にしている。
      if (seq <= order.applied) return undefined;
      order.applied = seq;
      const merged = [...fetched];
      // bdboard-gtv0: 削除したスレッドを、削除より前に始まった fetch(seq が削除点以下)の一覧から除く。
      // 書き込みの重ね合わせより前に行う。forgetEntry はそのスレッドの writes を消すので、ここで残っている
      // writes[X] は削除より後に入ったもの(削除後の upsert)だけで、削除より新しい手元の事実だから、
      // 除去のあとに重ねて勝たせる。削除後のリネーム応答(replace)は一覧に無い行を足さないので、
      // 前に除去しても後に除去しても結果は同じ — 順序が効くのは削除後の upsert だけ。
      // 削除より後に始まった fetch(seq が削除点より大きい)はサーバーが削除を反映済みなので応答を信じる。
      // 削除の記録は、いま当てた seq が削除点以上になったら役目を終える(以後はこの seq 以下の応答がすべて stale)。
      for (const [sessionId, forgottenAt] of order.forgotten) {
        if (forgottenAt >= seq) {
          const index = merged.findIndex((thread) => thread.sessionId === sessionId);
          if (index >= 0) merged.splice(index, 1);
        }
        if (forgottenAt <= seq) order.forgotten.delete(sessionId);
      }
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
      // bdboard-gtv0: 払い出し済みで未着の fetch(applied < issued)があるときだけ、削除の記録を残す。
      // applied >= issued なら、削除前に始まった未着の fetch はすべて seq < applied で捨てられるので要らない。
      if (order.applied < order.issued) order.forgotten.set(sessionId, order.issued);
    },
    appliedList(projectId) {
      return orderOf(projectId).appliedList;
    },
  };
}
