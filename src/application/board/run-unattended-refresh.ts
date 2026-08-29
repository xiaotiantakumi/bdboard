export interface RunUnattendedRefreshDeps {
  /** watcher / interval から起動する、失敗しうる非同期処理本体 */
  readonly refresh: () => Promise<void>;
  /** テストで差し替えられるように注入可能にする。省略時は console.error */
  readonly onError?: (err: unknown) => void;
}

/**
 * watcher / 定期 interval など、呼び出し元が結果を待たない ("void" で呼ぶ) 起点から
 * refresh 処理を起動するための安全な wrapper。
 *
 * runRefresh 自体は /api/refresh 経由でも呼ばれ、そちらは呼び出し元 (HTTP ルート) が
 * await + try/catch して失敗を 500 として返す必要があるため、runRefresh 本体に catch を
 * 足して握り潰すことはできない (bdboard-66sp)。無人で起動される経路 (watcher /
 * setInterval) 側だけをこの wrapper 越しに呼ぶことで、rejection を確実に catch し、
 * unhandledRejection によるプロセス終了を防ぐ。
 */
export async function runUnattendedRefresh(
  deps: RunUnattendedRefreshDeps,
): Promise<void> {
  try {
    await deps.refresh();
  } catch (err) {
    if (deps.onError !== undefined) {
      deps.onError(err);
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Unattended refresh error: ${detail}`);
  }
}
