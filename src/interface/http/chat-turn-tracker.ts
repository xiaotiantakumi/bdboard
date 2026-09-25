// bdboard-sso1.17: chat-routes.ts (1015行) の分割で、
// completedTurns/failedTurns の per-project キューをここへ切り出した (move only,
// 挙動変更ゼロ)。GET/DELETE /api/chat/turn-status (chat-thread-routes.ts) と
// POST /api/chat/message・/api/chat/message/stream (chat-message-routes.ts /
// chat-message-stream-routes.ts) の両方がこの状態を読み書きするため、所有者を
// ここ1か所に保ち、createChatRoutes (chat-routes.ts) で1回だけ生成して両方へ渡す
// (状態を複製しない)。

/**
 * 1プロジェクトが抱える未回収完了の上限 (bdboard-3tw.156)。ACK しないクライアント
 * に備えた歯止めで、通常運用で複数溜まるのは「返信を待たずに別スレッドへ移った」
 * 分だけなので、この数に届くことは想定していない。
 */
const CHAT_COMPLETED_TURNS_MAX = 20;

/**
 * sessionId 無しの failed エントリを ACK 経路なしに残しておける上限時間
 * (bdboard-kg0m)。sessionId 無し失敗 (新規スレッドの初回送信失敗、
 * FailedChatTurn の doc comment 参照) には DELETE /api/chat/turn-status での
 * ACK 手段が無く、これまでは CHAT_COMPLETED_TURNS_MAX の上限に達するまで
 * 消えなかった。その間、当該プロジェクトを見ている「自分では何も送信して
 * いない」クライアントの checkTurnStatus (chat/useTurnStatusRecovery.ts) がポーリングする
 * たびに 'failed' を検知するが、matchesTrackedSend も detached も
 * 一致しないため消化できず、無条件に 1 秒間隔で再ポーリングし続ける —
 * そのポーリングは、このエントリが (キュー自体の上限
 * CHAT_COMPLETED_TURNS_MAX に達する等で) 消えるまで際限なく続く。
 *
 * クライアント側には自分自身が絡む検知失敗を諦めて自己解決する猶予
 * (UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS、turnStatusPolicy.ts で約20〜30秒)
 * が既にあるので、このTTLはそれより十分長く取り、正当な回収中クライアントの
 * 振る舞いには決して干渉しないようにする。
 */
const FAILED_TURN_SESSIONLESS_TTL_MS = 60_000;

export interface CompletedChatTurn {
  readonly sessionId: string;
  readonly agentId: string;
  readonly completedAt: string;
}

/**
 * bdboard-3tw.165: completedTurns と並行して失敗ターンも憶えておく。turn-status の
 * ポーリング側 (web) が「processing から completed を経ずに idle へ落ちた」ことから
 * 失敗を推測するのをやめ、サーバーが明示できるようにする。
 *
 * sessionId が無いことがある: エージェントがまだセッションを払い出す前に失敗した
 * 新規スレッドの場合。ACK (DELETE /api/chat/turn-status) は sessionId が分かって
 * いるケースだけ completed と相乗りさせる (turnTracker.ackFailed)。sessionId 不明な失敗は
 * 参照できる識別子がクライアント側にも無いので、専用の ACK 経路は作らず
 * CHAT_COMPLETED_TURNS_MAX の上限で自然に押し出す。それとは別に、
 * bdboard-kg0m で FAILED_TURN_SESSIONLESS_TTL_MS を超えたものは GET
 * /api/chat/turn-status のたびにも刈り取られる (pruneExpiredSessionlessFailedTurn)。
 */
export interface FailedChatTurn {
  readonly sessionId?: string;
  readonly agentId: string;
  readonly code: string;
  readonly failedAt: string;
}

export interface ChatTurnTracker {
  recordCompleted(projectId: string, entry: CompletedChatTurn): void;
  ackCompleted(projectId: string, sessionId: string): void;
  /** 最古の未回収完了 (無ければ undefined)。 */
  peekCompleted(projectId: string): CompletedChatTurn | undefined;
  recordFailed(projectId: string, entry: FailedChatTurn): void;
  ackFailed(projectId: string, sessionId: string): void;
  /**
   * sessionId 無しの期限切れエントリを刈り取ったうえで、sessionId 有りのものを
   * 優先し、無ければ最古のエントリ (sessionId 無し) を返す (turn-status GET の
   * 選択ロジックをそのままここへ移した。詳細は元の doc comment 参照)。
   */
  peekFailed(projectId: string): FailedChatTurn | undefined;
}

export function createChatTurnTracker(now: () => Date): ChatTurnTracker {
  // 未回収の完了ターン。クライアントが ACK するまでサーバーが持つ。
  //
  // プロジェクト1枠ではなく **キュー** なのは、1枠だと「スレッドAの返信を待たずに
  // 別スレッドへ移り、そちらで送信した」時点でAの完了が黙って上書きされ、
  // Aの返信が永久に回収されなくなるため (bdboard-3tw.155 で実測)。同じ
  // sessionId の完了は最新で置き換え、古いものから順に配る。
  //
  // ACK しないクライアントに備えて上限を切る。溢れたら古い方から捨てる —
  // 取りこぼしは「その1スレッドが再取得されるまで古いまま」で済むが、
  // 無制限に積むとプロセスが太り続ける。
  const completedTurns = new Map<string, readonly CompletedChatTurn[]>();
  const recordCompleted = (projectId: string, entry: CompletedChatTurn): void => {
    const queued = completedTurns.get(projectId) ?? [];
    const next = [...queued.filter((item) => item.sessionId !== entry.sessionId), entry];
    completedTurns.set(projectId, next.slice(-CHAT_COMPLETED_TURNS_MAX));
  };
  const ackCompleted = (projectId: string, sessionId: string): void => {
    const queued = completedTurns.get(projectId);
    if (queued === undefined) return;
    const next = queued.filter((item) => item.sessionId !== sessionId);
    if (next.length === 0) {
      completedTurns.delete(projectId);
      return;
    }
    completedTurns.set(projectId, next);
  };

  // bdboard-3tw.165: failedTurns の記録・ACK。completedTurns と同じ形の per-project
  // キューだが、sessionId が無いエントリがあり得るので dedupe/フィルタは sessionId が
  // 分かっているものだけに絞る。
  //
  // bdboard-96rp (Opus レビュー指摘 B1、round 2 再レビューでコメント文言を修正):
  // sessionId 無しのエントリどうしも dedupe する (既存の sessionId 無しエントリは
  // 全部落として、新しい1件だけを積む)。単一ロックの isBusy により「同時に2件の
  // sessionId 無し失敗が *記録される*」ことは無い (isBusy の解放は runTurn の
  // finally が recordFailed の後に行うため、記録自体は直列化されている) が、
  // これは「未解決の sessionId 無し失敗が高々1件しか存在しない」ことまでは保証しない
  // — 例えば1件目が (ACK 経路が無いまま) クライアントに回収されないうちに、
  // 別の (後続の、無関係な) sessionId 無し送信が2件目を記録することは普通にあり得る。
  // dedupe はこの2件目で1件目を意図的に上書きする: 古いエントリが先頭に居座ったまま
  // 後から積まれた別の sessionId 無し失敗をクライアントの checkTurnStatus から
  // 見えなくしてしまう害の方が、稀に「本当は1件目を待っていたクライアントが2件目の
  // 結果で解決してしまう」害より大きいと判断した (turnStatusPolicy.ts 側にも
  // UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS による猶予後の受け入れがあり、
  // どのみち無期限には待たない)。GET が返す sessionId 無しエントリは常に「最新の
  // 1件」になり、クライアント側の detachedAt 突き合わせ (chat/useTurnStatusRecovery.ts の
  // checkTurnStatus) が正しく解決できる。
  const failedTurns = new Map<string, readonly FailedChatTurn[]>();
  const recordFailed = (projectId: string, entry: FailedChatTurn): void => {
    const queued = failedTurns.get(projectId) ?? [];
    const next =
      entry.sessionId !== undefined
        ? [...queued.filter((item) => item.sessionId !== entry.sessionId), entry]
        : [...queued.filter((item) => item.sessionId !== undefined), entry];
    failedTurns.set(projectId, next.slice(-CHAT_COMPLETED_TURNS_MAX));
  };
  const ackFailed = (projectId: string, sessionId: string): void => {
    const queued = failedTurns.get(projectId);
    if (queued === undefined) return;
    const next = queued.filter((item) => item.sessionId !== sessionId);
    if (next.length === 0) {
      failedTurns.delete(projectId);
      return;
    }
    failedTurns.set(projectId, next);
  };
  // bdboard-kg0m: sessionId 無しの failed エントリは ACK 経路が無く、
  // CHAT_COMPLETED_TURNS_MAX の上限に達するまでは消えない。上限にまだ余裕が
  // あると、無関係な閲覧者の checkTurnStatus ポーリングが「差分なし」を
  // 検知できないまま無条件に 1 秒間隔で回り続けてしまう (詳細は
  // FAILED_TURN_SESSIONLESS_TTL_MS の doc comment を参照)。GET のたびに TTL を
  // 過ぎた sessionId 無しエントリだけを取り除く。sessionId 有りのエントリは
  // 引き続き ACK で明示的に消えるのでここでは手を付けない。
  const pruneExpiredSessionlessFailedTurn = (projectId: string): void => {
    const queued = failedTurns.get(projectId);
    if (queued === undefined) return;
    const nowMs = now().getTime();
    const next = queued.filter(
      (entry) =>
        entry.sessionId !== undefined ||
        nowMs - Date.parse(entry.failedAt) <= FAILED_TURN_SESSIONLESS_TTL_MS,
    );
    if (next.length === queued.length) return;
    if (next.length === 0) {
      failedTurns.delete(projectId);
      return;
    }
    failedTurns.set(projectId, next);
  };

  return {
    recordCompleted,
    ackCompleted,
    peekCompleted: (projectId) => completedTurns.get(projectId)?.[0],
    recordFailed,
    ackFailed,
    peekFailed: (projectId) => {
      // bdboard-96rp: sessionId 有りのエントリを sessionId 無しより優先して返す。
      // sessionId 無し (新規スレッドの初回送信中の失敗、FailedChatTurn の doc comment
      // 参照) は ACK 経路が無く CHAT_COMPLETED_TURNS_MAX の上限に達するまで消えない —
      // 素朴に [0] (最古) を返すと、それが先頭に居座っている間、後から積まれた
      // sessionId 有りの (=クライアントが ACK して正しく前進できる) 失敗が同じプロジェクト
      // の別セッションから永遠に見えなくなってしまう。sessionId 有りのものが1件でも
      // あれば (キュー内の相対順序を保ったまま) それを優先して返し、無ければ従来どおり
      // 最古のエントリ (sessionId 無し) を返す。
      // bdboard-kg0m: 取得前に TTL を過ぎた sessionId 無しエントリを刈り取る。
      pruneExpiredSessionlessFailedTurn(projectId);
      const failedQueue = failedTurns.get(projectId);
      return failedQueue?.find((entry) => entry.sessionId !== undefined) ?? failedQueue?.[0];
    },
  };
}
