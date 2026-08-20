export const EXPECTED_BD_VERSION = '1.2.1';

export type BdVersionCheckStatus = 'match' | 'mismatch' | 'unknown';

export interface BdVersionCheck {
  readonly status: BdVersionCheckStatus;
  readonly message: string;
}

/**
 * infrastructure 層が取得した bd のバージョンを、bdboard が前提とする版と比較する。
 * 取得できないこと自体は起動失敗にしないため unknown として返す。
 */
export function evaluateBdVersion(
  actualVersion: string | null,
  expectedVersion = EXPECTED_BD_VERSION,
): BdVersionCheck {
  if (actualVersion === null) {
    return {
      status: 'unknown',
      message: `bd CLI version could not be determined; expected ${expectedVersion}.`,
    };
  }

  if (actualVersion === expectedVersion) {
    return {
      status: 'match',
      message: `bd CLI version matches expected ${expectedVersion}.`,
    };
  }

  return {
    status: 'mismatch',
    message: `bd CLI version mismatch: expected ${expectedVersion}, found ${actualVersion}. See README for why ${expectedVersion} is pinned (bd-m7zzd regression).`,
  };
}
