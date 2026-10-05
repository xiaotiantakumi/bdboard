import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { BdExternalRefReaderPort } from '../../application/ports/external-issue-source.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { withTransientReadRetry } from './bd-retry.js';
import { classifyBdError } from './classify-bd-error.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliExternalRefReaderOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

// --brief は description 等を落として出力を約 1/4 にする (external_ref は残る)。全件 JSON は
// 700 件で約 3MB ある (scripts/check-gh-issues.mjs と同じ理由)。
function buildListArgs(rootPath: string): readonly string[] {
  return [
    '--readonly',
    '-C',
    rootPath,
    'list',
    '--all',
    '--json',
    '--limit',
    '0',
    '--brief',
    '--no-pager',
  ];
}

/** bd の出力は配列と `{issues: [...]}` の両方がありうる (scripts/check-gh-issues.mjs と同じ)。 */
function extractEntries(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === 'object' && parsed !== null && 'issues' in parsed) {
    return parsed.issues;
  }
  return undefined;
}

/**
 * bdboard 自身の bd の `external_ref` を全件 (closed を含む) 読む。lease-reader と同じ作法:
 * `--readonly -C <root> … --no-pager`、失敗は BdError、一時的な失敗は数回まで再試行する。
 * `external_ref` が文字列でない要素は黙って飛ばす (紐付けなし側に倒れる。誤報はしても見逃しはしない)。
 */
export function createBdCliExternalRefReader(
  commandRunner: CommandRunner,
  options?: BdCliExternalRefReaderOptions,
): BdExternalRefReaderPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listExternalRefs(projectRootPath: string): Promise<readonly string[]> {
      const commandResult = await withTransientReadRetry(async () => {
        const result = await commandRunner.run(bdPath, buildListArgs(projectRootPath), {
          timeoutMs,
        });
        if (result.exitCode !== 0) {
          const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
          const kind =
            result.failureKind === 'timeout' ? 'timeout' : classifyBdError(result.exitCode, combined);
          throw new BdError(
            kind,
            projectRootPath,
            combined.trim() || `exit code ${result.exitCode}`,
          );
        }
        return result;
      });

      const trimmedStdout = commandResult.stdout.trim();
      if (trimmedStdout.length === 0) {
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedStdout) as unknown;
      } catch {
        throw new BdError('schema-mismatch', projectRootPath, 'invalid JSON in stdout');
      }

      const entries = extractEntries(parsed);
      if (!Array.isArray(entries)) {
        throw new BdError('schema-mismatch', projectRootPath, 'expected JSON array or {issues: []}');
      }

      const externalRefs: string[] = [];
      for (const entry of entries as unknown[]) {
        if (typeof entry !== 'object' || entry === null || !('external_ref' in entry)) {
          continue;
        }
        if (typeof entry.external_ref === 'string') {
          externalRefs.push(entry.external_ref);
        }
      }
      return externalRefs;
    },
  };
}
