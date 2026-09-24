import type { BdErrorKind } from '../../application/ports/issue-repository.js';

const LOCK_CONTENTION_PATTERN = /\block\w*\b/;
const BD_NOT_FOUND_PATTERN = /\bbd\b[\s:'"-]{0,5}not found\b/;
// bdboard-vpt3: 負荷が高い時間帯に「他プロジェクトの bd 読み取り」が断続的に
// context canceled でタイムアウトする件の原因調査で判明した表現。bd はこちら側
// (NodeCommandRunner) が timeoutMs 経過で送る SIGTERM/SIGKILL を受けて、進行中の
// Dolt トランザクションの context を cancel してから終了する — Go の慣用表現で
// stderr に "context canceled" / "context deadline exceeded" が出る。
// exitCode は SIGKILL 経由だと null → -1 に潰れることがあり、下の bd-not-found
// 判定 (exitCode === -1) より前に置かないと誤って bd-not-found に分類される
// (bdboard-xgvh で exitCode -1 が spawn E2BIG とも衝突すると分かっている、
// 同じ exitCode -1 の多義性の別ケース)。
const TIMEOUT_PATTERN = /context canceled|context deadline exceeded/;

export function classifyBdError(
  exitCode: number,
  combinedOutput: string,
): BdErrorKind {
  // NOTE: "not a beads project" must be checked BEFORE the bd-not-found branch,
  // because bd phrases that error as ".beads not found" and would otherwise be
  // swallowed by the bd-not-found branch.
  if (
    combinedOutput.includes('not a beads project') ||
    combinedOutput.includes('no .beads') ||
    combinedOutput.includes('.beads not found') ||
    combinedOutput.includes('beads directory')
  ) {
    return 'not-a-beads-project';
  }

  // NOTE: must be checked BEFORE bd-not-found — a SIGKILL-terminated bd process
  // can report exitCode -1, which the bd-not-found branch below would otherwise
  // claim first and hide the real (timeout) cause.
  if (TIMEOUT_PATTERN.test(combinedOutput)) {
    return 'timeout';
  }

  if (
    exitCode === 127 ||
    exitCode === -1 ||
    combinedOutput.includes('command not found') ||
    combinedOutput.includes('enoent') ||
    BD_NOT_FOUND_PATTERN.test(combinedOutput)
  ) {
    return 'bd-not-found';
  }

  if (LOCK_CONTENTION_PATTERN.test(combinedOutput)) {
    return 'lock-contention';
  }

  return 'unknown';
}
