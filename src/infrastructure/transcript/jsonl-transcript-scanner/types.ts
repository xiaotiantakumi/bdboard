import type { BoardCache } from '../../../application/ports/board-cache.js';
import type { FileSystemPort } from '../../../application/ports/file-system.js';
import type { ScanTarget } from '../../../application/transcript/scan-plan.js';
import type { Project } from '../../../domain/project.js';

export interface ScannerOptions {
  readonly projectsDir?: string;
  readonly initialTailBytes?: number;
  readonly budgetBytes?: number;
}

export interface TargetMeta {
  readonly previousOffset: number | undefined;
  readonly size: number;
}

export interface TargetWithProject {
  readonly target: ScanTarget;
  readonly project: Project;
}

/**
 * fs/cache と、createJsonlTranscriptScanner() が options から解決した projectsDir/planOptions を
 * まとめて受け渡すための共有型。
 *
 * createJsonlTranscriptScanner() がクロージャで捕捉していたこれらの値を、分割後の各モジュール
 * 関数へ明示引数として渡すために導入した (挙動は変えていない。git-worktree-scanner 分割 #616
 * の ScannerDeps と同じ方式)。
 */
export interface ScannerDeps {
  readonly fs: FileSystemPort;
  readonly cache: BoardCache;
  readonly projectsDir: string;
  readonly planOptions: { readonly initialTailBytes?: number; readonly budgetBytes?: number } | undefined;
}
