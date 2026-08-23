import { evaluateBdVersion } from '../../domain/bd-version-check.js';

export interface BdVersionStartupLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * 起動時の bd バージョン確認を best-effort で行う。診断失敗は起動失敗にしない。
 */
export async function runBdVersionStartupCheck(
  readVersion: () => Promise<string | null>,
  logger: BdVersionStartupLogger,
): Promise<void> {
  try {
    const result = evaluateBdVersion(await readVersion());
    if (result.status === 'mismatch') {
      logger.warn(result.message);
    } else {
      // 'match' と 'unknown' はどちらも同じ log レベルで出す。
      // 'unknown' を無音にすると「bd が見つからない/読めない」場合と
      // 「バージョンが一致している」場合が起動ログ上で区別できなくなり、
      // ドリフト検知が最も必要な瞬間(bd 実行環境が壊れている)に無言で
      // 機能停止しているように見えてしまう。
      logger.log(result.message);
    }
  } catch {
    // Version drift detection must remain best-effort and never block startup.
  }
}
