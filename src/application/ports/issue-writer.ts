export interface IssueWriterPort {
  claim(rootPath: string, ticketId: string): Promise<void>;
  close(rootPath: string, ticketId: string, reason?: string): Promise<void>;
  defer(rootPath: string, ticketId: string, untilDate: string): Promise<void>;
  setPriority(rootPath: string, ticketId: string, priority: number): Promise<void>;
  addComment(rootPath: string, ticketId: string, text: string): Promise<void>;
  /**
   * close の逆操作。ステータスを open に戻し closed_at をクリアする(bd reopen 相当)。
   *
   * 元がクローズ状態でなくても `bd reopen` は exit 0 のまま何もしない
   * (stderr に 'is not closed; nothing to do' 相当のメッセージを出すだけでエラーには
   * ならない。bd 1.2.1 で実測確認済み・bdboard-3tw.93)。エラーを返してくれる前提だった
   * 旧実装はこれを黙って成功したものとして UI に「元に戻しました」と偽の成功を表示して
   * しまっていた。undoPriority(bdboard-3tw.82)と同じ read-then-write CAS で対処する:
   * 呼び出し前に bd show で現在ステータスを読み、'closed' でなければ書き込まずに
   * StatusConflictError を投げる。
   */
  reopen(rootPath: string, ticketId: string): Promise<void>;
  /**
   * claim の逆操作。assignee を解除しステータスを open に戻す(bd unclaim 相当)。
   * bd unclaim は「現在の assignee 自身しか解除できない」ガードを持つため、claim 後に
   * 別のアクターへ付け替わっていた場合は自然に失敗する(逆操作の取りこぼしを防ぐ)。
   */
  unclaim(rootPath: string, ticketId: string): Promise<void>;
  /**
   * defer の逆操作。ステータスを open に戻し defer 日付をクリアする(bd undefer 相当)。
   *
   * bd undefer は「現在ステータスが deferred でなければ何もしない」ガードを持つが、
   * このガードは exit 0 のまま no-op するだけで、エラーにはならない(bd 1.2.1 で実測
   * 確認済み・bdboard-3tw.93)。以前のコメントは「reopen/unclaim と同じ形の built-in
   * ガード」としていたが、それは「無言で上書きしない」という意味では正しくても、
   * 「エラーを返す」という意味では誤りだった — 呼び出し元はこの exit 0 を成功と
   * 見なしてしまい、実際には何も戻っていないのに Undo が成功したかのように振る舞う。
   * undoPriority(bdboard-3tw.82)と同じ read-then-write CAS で対処する: 呼び出し前に
   * bd show で現在ステータスを読み、'deferred' でなければ書き込まずに
   * StatusConflictError を投げる。
   */
  undefer(rootPath: string, ticketId: string): Promise<void>;
  /**
   * priority の逆操作。bd update には --if-assignee/--if-status はあるが
   * --if-priority が無いため、setPriority を直接叩くと Undo 実行までの間に
   * 別セッションが優先度を変えていた場合に無言で上書きしてしまう(bdboard-3tw.82)。
   *
   * ここでは「実行直前に bd show で現在値を読み、クイックアクション実行直後の値
   * (expectedCurrentPriority)と一致する場合だけ previousPriority へ書き戻す」という
   * read-then-write 方式で対処する。読み取りと書き込みの間にはまだ小さな競合窓が残る
   * (厳密な compare-and-swap ではない)が、ユーザーが Undo を押すまでの数秒〜スナックバー
   * 表示中の窓を数十msまで縮められる。
   *
   * 現在値が expectedCurrentPriority と一致しない場合は書き込まずに
   * PriorityConflictError を投げる。
   */
  undoPriority(
    rootPath: string,
    ticketId: string,
    expectedCurrentPriority: number,
    previousPriority: number,
  ): Promise<void>;
}

/**
 * undoPriority の競合検知(read-then-write の read で不一致を見つけた場合)。
 * ルーティング層(interface/http/routes.ts)がこの型を instanceof で見分けて
 * 409 を返す(UI が「他のセッションが変更しました」と表示できるようにするため)。
 */
export class PriorityConflictError extends Error {
  readonly ticketId: string;
  readonly expectedPriority: number;
  readonly actualPriority: number;

  constructor(ticketId: string, expectedPriority: number, actualPriority: number) {
    super(
      `priority for ${ticketId} changed since the quick action ran ` +
        `(expected ${expectedPriority}, current ${actualPriority})`,
    );
    this.name = 'PriorityConflictError';
    this.ticketId = ticketId;
    this.expectedPriority = expectedPriority;
    this.actualPriority = actualPriority;
    Object.setPrototypeOf(this, PriorityConflictError.prototype);
  }
}

/**
 * reopen/undefer の競合検知(read-then-write の read で不一致を見つけた場合)。
 * `bd reopen` / `bd undefer` は前提条件を満たさなくても exit 0 のまま no-op するだけで
 * エラーにならない(bdboard-3tw.93)ため、呼び出し前に bd show で現在ステータスを読み、
 * Undo が前提とするステータス(close の Undo なら 'closed'、defer の Undo なら
 * 'deferred')と一致するときだけ実コマンドを実行する。不一致ならここで検知して書き込まず
 * 済ませる。ルーティング層(interface/http/routes.ts)がこの型を instanceof で見分けて
 * 409 を返す(UI が「他のセッションが変更しました」と表示できるようにするため、
 * PriorityConflictError と同じ形)。
 */
export class StatusConflictError extends Error {
  readonly ticketId: string;
  readonly expectedStatus: string;
  readonly actualStatus: string;

  constructor(ticketId: string, expectedStatus: string, actualStatus: string) {
    super(
      `status for ${ticketId} changed since the quick action ran ` +
        `(expected ${expectedStatus}, current ${actualStatus})`,
    );
    this.name = 'StatusConflictError';
    this.ticketId = ticketId;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
    Object.setPrototypeOf(this, StatusConflictError.prototype);
  }
}
