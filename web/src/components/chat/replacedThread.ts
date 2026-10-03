/**
 * bdboard-drfb / bdboard-w9hv: 「スレッド B から送ったら別のセッション C が返ってきた」ときの
 * 置き換え判断(B を open・永続化・読込済み印・会話ストアから外す)を、送信の成功
 * (chat/useChatSendCommits.ts の commitSuccess)と turn-status 回収
 * (chat/useChatSessionLifecycle.ts の applyRecoveredTurn)の両方から同じ規則で呼べるよう
 * 純粋関数へ切り出したもの。React にも localStorage にも依存しない。
 */

/**
 * 置き換えの判断材料として憶えておく印。state ではなく ref に置く(描画に使わず、書き込みも
 * 読み取りもイベントの中だけ)。chat/useChatSendState.ts が ref を持つ。
 */
export interface ReplacedThreadMarks {
  /**
   * bdboard-drfb: 「サーバーにもうそのセッションが無い」(400 unknown chat session)で送信に
   * 失敗した会話キー。commitFailure が入れ、次の commitSuccess が delete しながら読む。再送が
   * 新しいセッションへ移るとき、死んだスレッドをスレッド一覧からも落とす判定に使う
   * (chat agent mismatch のスレッドはサーバーで生きているので入れない)。turn-status 回収
   * (applyRecoveredTurn)が takeUnobservedOrigin で送信元を引き取るときも、その会話キーの印を
   * 消す(回収はサーバーの一覧でスレッド一覧を置き換えるので、印で絞る必要が無い)。
   */
  goneKeys: Set<string>;
  /**
   * bdboard-w9hv: projectId → 結果を見届けられなかった(abort / 配信停止)、sessionId 無しの
   * 送信の会話キー。sessionId 無しの送信は未解決の印(markUnresolvedSend)を付けられず、
   * turn-status 回収が返すセッションがどのスレッドの送信だったかを辿れないため、ここに憶える。
   * 回収(applyRecoveredTurn)が引き取る。引き取られないまま同じ会話キーの送信が成功したとき
   * (commitSuccess)は、clearUnobservedOriginFor が消す。
   */
  unobservedOrigins: Record<string, string>;
}

export function createReplacedThreadMarks(): ReplacedThreadMarks {
  return { goneKeys: new Set(), unobservedOrigins: {} };
}

/**
 * 結果を見届けられなかった送信(abort / 配信停止)の元の会話キーを憶える。sessionId 付きの送信は
 * 返ってくるセッションが元の sessionId と同じのはずなので憶えない(markUnresolvedSend が担う)。
 */
export function markUnobservedSend(
  marks: ReplacedThreadMarks,
  projectId: string,
  sendKey: string,
  sendSessionId: string | undefined,
): void {
  if (sendSessionId === undefined) marks.unobservedOrigins[projectId] = sendKey;
}

/**
 * 回収が引き取る。記録を消して返す。その会話キーの gone の印もここで消す(回収はサーバーの
 * 一覧でスレッド一覧を置き換えるので、gone の印で一覧を絞る必要が無い。印を残さない)。
 */
export function takeUnobservedOrigin(marks: ReplacedThreadMarks, projectId: string): string | undefined {
  const origin = marks.unobservedOrigins[projectId];
  if (origin === undefined) return undefined;
  delete marks.unobservedOrigins[projectId];
  marks.goneKeys.delete(origin);
  return origin;
}

/**
 * 送信が成功して(commitSuccess)会話キー key が確定したとき、そのプロジェクトの記録が key のものなら
 * 消す。成功した時点で、その送信元は commitSuccess 自身が open・永続化・会話ストアから処理済みで、
 * 記録を残すと、後の無関係な turn-status 回収が別のスレッドを置き換えとして閉じてしまう。
 * 別の会話キーの記録は(別の送信のものなので)消さない。
 */
export function clearUnobservedOriginFor(marks: ReplacedThreadMarks, projectId: string, key: string): void {
  if (marks.unobservedOrigins[projectId] === key) delete marks.unobservedOrigins[projectId];
}

export interface ReplacedThreadPlan {
  /** 置き換えられた開いている実スレッドの会話キー。置き換えが無ければ undefined。 */
  replacedKey: string | undefined;
  /** replacedKey を除き、newSessionId を末尾に置いた次の open。 */
  nextOpen: string[];
  /**
   * 置き換えが unknown chat session 由来で、スレッド一覧からも落とすべき会話キー。open に居ない
   * キー(ドラフトキー等)でも、sessionGone で別セッションへ移ったなら入る(replacedKey が
   * undefined でも goneSessionId は立つ。従来の挙動)。
   */
  goneSessionId: string | undefined;
}

/**
 * convKey(送信元の会話キー。回収で元が分からなければ undefined)が newSessionId と違い、かつ
 * open に居る実スレッドなら、そのスレッドはこの送信で置き換えられた。ドラフトキーは open に
 * 入らないので、ドラフトからの初回送信では当たらない。open が未確定(undefined)なら空として扱う。
 */
export function planReplacedThread(input: {
  convKey: string | undefined;
  newSessionId: string;
  open: readonly string[] | undefined;
  sessionGone: boolean;
}): ReplacedThreadPlan {
  const { convKey, newSessionId, open = [], sessionGone } = input;
  const moved = convKey !== undefined && convKey !== newSessionId;
  const replacedKey = moved && open.includes(convKey) ? convKey : undefined;
  return {
    replacedKey,
    nextOpen: [...open.filter((id) => id !== newSessionId && id !== replacedKey), newSessionId],
    goneSessionId: moved && sessionGone ? convKey : undefined,
  };
}

/**
 * commitSuccess が永続化(writePersistedChatThread)の liveOpen として渡す open の基点。
 * 復元済みで live の open が分かるなら、メモリの次状態(plan.nextOpen)と同じにする(bdboard-7feq)。
 * 未復元は永続化済みエントリが基点(undefined = 従来どおり)だが、置き換えが起きたときだけは、
 * そのエントリから置き換えられたスレッドと新セッションを除いた open を渡す(bdboard-drfb)。永続化済みエントリは
 * 置き換えのときだけ読むので、読み取りは呼び出し側が関数で渡す。
 */
export function persistedOpenBaseAfterCommit(input: {
  restored: boolean;
  liveOpen: readonly string[] | undefined;
  plan: ReplacedThreadPlan;
  newSessionId: string;
  readPersistedOpen: () => readonly string[];
}): string[] | undefined {
  const { restored, liveOpen, plan, newSessionId, readPersistedOpen } = input;
  if (restored && liveOpen !== undefined) return plan.nextOpen;
  if (plan.replacedKey === undefined) return undefined;
  return readPersistedOpen().filter((id) => id !== plan.replacedKey && id !== newSessionId);
}

/**
 * historyLoadedFor の次状態。loadedId を読込済みにし、置き換えられた実スレッドの印は外す
 * (conversations[replacedKey] を消すのと対)。印を残すと、そのスレッドを開き直しても履歴 effect が
 * early return して履歴 GET が走らず、死んだ/古い sessionId で再送してしまう。
 */
export function withHistoryLoaded(
  loaded: Record<string, true>,
  loadedId: string,
  replacedKey: string | undefined,
): Record<string, true> {
  const next: Record<string, true> = { ...loaded, [loadedId]: true };
  if (replacedKey !== undefined) delete next[replacedKey];
  return next;
}

/** record から key を除いた浅いコピー。key が無ければ record をそのまま返す。 */
export function withoutKey<T>(record: Record<string, T>, key: string | undefined): Record<string, T> {
  if (key === undefined || !(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
