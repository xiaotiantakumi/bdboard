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
    } else if (result.status === 'match') {
      logger.log(result.message);
    }
  } catch {
    // Version drift detection must remain best-effort and never block startup.
  }
}
