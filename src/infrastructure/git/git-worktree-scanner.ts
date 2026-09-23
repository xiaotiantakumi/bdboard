// src/infrastructure/git/git-worktree-scanner.ts は bdboard-sso1.49 でモジュール分割された。
// 実体は ./git-worktree-scanner/ 配下:
//   - deps.ts          : commandRunner/gitPath/timeoutMs をまとめた ScannerDeps 型
//   - git-command.ts   : git CLI 実行の共通ラッパー (runGit / runGitReadOnly)
//   - scan-parsing.ts  : `git worktree list --porcelain` / `git branch --list bd/*` の出力パース
//   - scan.ts          : scan() 本体 (worktree 一覧 + bd/* ブランチ一覧の取得)
//   - nul-records.ts   : NUL 区切り出力の分解 (splitNulRecords)
//   - status-parsing.ts: `git status --porcelain -z` の出力パースと重複除去 (normalizeFiles)
//   - merge-base.ts    : HEAD SHA 取得と merge-base 解決
//   - harness-lag.ts   : countHarnessCommitsBehindDefaultBranch() 本体
//   - changed-files.ts : listChangedFiles() 本体 (コミット済み差分キャッシュを含む)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import { createChangedFilesReader } from './git-worktree-scanner/changed-files.js';
import type { ScannerDeps } from './git-worktree-scanner/deps.js';
import { countHarnessCommitsBehindDefaultBranch } from './git-worktree-scanner/harness-lag.js';
import { scanWorktrees } from './git-worktree-scanner/scan.js';

const DEFAULT_GIT_PATH = 'git';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GitWorktreeScannerOptions {
  readonly gitPath?: string;
  readonly timeoutMs?: number;
}

export function createGitWorktreeScanner(
  commandRunner: CommandRunner,
  options?: GitWorktreeScannerOptions,
): WorktreeScanner {
  const gitPath = options?.gitPath ?? DEFAULT_GIT_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deps: ScannerDeps = { commandRunner, gitPath, timeoutMs };

  return {
    countHarnessCommitsBehindDefaultBranch: (worktreePath, lagOptions) =>
      countHarnessCommitsBehindDefaultBranch(deps, worktreePath, lagOptions),

    scan: (rootPath: string) => scanWorktrees(deps, rootPath),

    listChangedFiles: createChangedFilesReader(deps),
  };
}
