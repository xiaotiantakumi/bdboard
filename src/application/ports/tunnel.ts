export interface TunnelStartResult {
  readonly url: string;
}

/** cloudflared プロセスの起動/停止を抽象化する */
export interface TunnelProcess {
  /** 起動して公開URLを返す。失敗時は例外を投げてよい(呼び出し側が必ず捕捉する) */
  start(): Promise<TunnelStartResult>;
  stop(): Promise<void>;
  /** cloudflared が使えるか(結果をキャッシュしてよい) */
  isAvailable(): Promise<boolean>;
  /**
   * 起動成功後、こちら(stop())からの停止指示なしにプロセスが終了した場合に呼ばれる
   * (例: 開発サーバー本体の再起動に子プロセスとして巻き込まれた場合)。
   * 呼び出し側が明示的に stop() した場合は呼ばれない。任意実装(未実装のportもありうる)。
   */
  onUnexpectedExit?(listener: () => void): void;
}
