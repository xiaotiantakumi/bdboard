import type { BdErrorKind } from '../../application/ports/issue-repository.js';

const LOCK_CONTENTION_PATTERN = /\block\w*\b/;
const BD_NOT_FOUND_PATTERN = /\bbd\b[\s:'"-]{0,5}not found\b/;

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
