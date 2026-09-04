export interface ScannedProcess {
  readonly pid: number;
  /** 実行ファイル名のみ（例: "claude", "cursor-agent", "agy"）。引数は含めない */
  readonly command: string;
  readonly cwd: string;
  readonly startedAt?: Date;
}

/** bd heartbeat ループ 1 本。listHeartbeatLoops() の戻り */
export interface ScannedHeartbeatLoop {
  readonly pid: number;
  /** ps から取れたコマンドライン全文（引数込み）。チケットID抽出の材料 */
  readonly commandLine: string;
  readonly startedAt?: Date;
  /** ps の lstart 生文字列。kill コマンドの pid-reuse ガードに使う */
  readonly lstart?: string;
  /**
   * bdboard-0kql の pidfile から解決した起動元セッションの PID。
   * pidfile が無い / 読めない / このループに対応する行が無いときは undefined。
   */
  readonly sessionPid?: number;
  /**
   * sessionPid が判明したときだけ入る。生死が判定できなければ undefined。
   * undefined は「死んでいる」ではなく「分からない」。
   */
  readonly sessionAlive?: boolean;
}

export interface ProcessScanner {
  listAgentProcesses(): Promise<readonly ScannedProcess[]>;
  /**
   * bd heartbeat ループを列挙する。**任意メソッド**。
   * 実装していないスキャナ（テストの fake 等）では hygiene 側が検知自体を行わない
   * — leftoverCandidates が undefined なら merged_leftover を出さないのと同じ流儀。
   */
  listHeartbeatLoops?(): Promise<readonly ScannedHeartbeatLoop[]>;
}
