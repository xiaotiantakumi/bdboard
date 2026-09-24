import type { BdErrorKind } from '../../application/ports/issue-repository.js';

const LOCK_CONTENTION_PATTERN = /\block\w*\b/;
const BD_NOT_FOUND_PATTERN = /\bbd\b[\s:'"-]{0,5}not found\b/;
// bdboard-vpt3: 負荷が高い時間帯に「他プロジェクトの bd 読み取り」が断続的に
// context canceled でタイムアウトする件の原因調査で判明した表現。呼び出し元が
// NodeCommandRunner の timeoutMs 経過で bd (Go 製・Dolt 使用) へ SIGTERM/SIGKILL
// を送ると、bd は進行中の Dolt トランザクションの context を cancel してから
// 終了することがある — Go の慣用表現で stderr に "context canceled" /
// "context deadline exceeded" が出る。呼び出し元は `CommandResult.failureKind
// === 'timeout'`(NodeCommandRunner 自身がタイマー発火を記録した、より確実な
// signal)を優先して見るべきで、ここでの文字列一致はその signal が無い経路
// (failureKind を経由しない呼び出しや、bd 自身の内部タイムアウト)向けの
// フォールバックに過ぎない(gh-cli-pr-status-reader.ts の classifyCommandFailure
// と同じ役割分担)。
// exitCode はシグナル経由の終了 (SIGTERM 単独でも、それに従わず後続の
// SIGKILL へ上げた場合でも) だと Node 側で null → -1 に潰れることがあり、
// 下の bd-not-found 判定 (exitCode === -1) より前に置かないと誤って
// bd-not-found に分類される (bdboard-xgvh で exitCode -1 が spawn E2BIG とも
// 衝突すると分かっている、同じ exitCode -1 の多義性の別ケース)。
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

  // NOTE: must be checked BEFORE bd-not-found — a signal-terminated bd process
  // (SIGTERM, or the follow-up SIGKILL if it didn't exit in time) can report
  // exitCode -1, which the bd-not-found branch below would otherwise claim
  // first and hide the real (timeout) cause.
  //
  // Guarded with `&& !LOCK_CONTENTION_PATTERN.test(...)`: bd can phrase its own
  // internal lock-wait deadline as "acquiring lock: ... context deadline
  // exceeded", which also matches TIMEOUT_PATTERN. That's still fundamentally a
  // lock-contention failure (short wait, likely to clear on its own), not the
  // client-side kill this timeout kind targets, so it must fall through to the
  // lock-contention branch below instead. This guard deliberately does NOT move
  // lock-contention ahead of bd-not-found in the overall ordering (unlike an
  // earlier revision of this function did) — bd-not-found keeping priority over
  // lock-contention matches every other caller's pre-existing expectation
  // (e.g. the write-path retry callers in bd-cli-human-decisions/shared.ts),
  // and this guard is enough to fix the lock-wait-deadline misclassification
  // without touching that unrelated ordering.
  if (
    TIMEOUT_PATTERN.test(combinedOutput) &&
    !LOCK_CONTENTION_PATTERN.test(combinedOutput)
  ) {
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
