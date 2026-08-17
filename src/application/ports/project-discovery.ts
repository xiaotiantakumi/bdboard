import type { Project } from '../../domain/project.js';

export interface ProjectDiscoveryConfig {
  readonly scanRoots: readonly string[];
  readonly excludePaths?: readonly string[];
  /** Max traversal depth from a scanRoot. Default 5 (DEFAULT_MAX_DEPTH). */
  readonly maxDepth?: number;
  /**
   * 1 回のスキャンで訪問するディレクトリ数の上限。超過したら走査を打ち切り、
   * そこまでの部分結果を返す(bdboard-bzd のサニティキャップ第二層)。
   * Default 50,000 (DEFAULT_SCAN_DIR_LIMIT)。
   */
  readonly maxDirectories?: number;
}

export interface ProjectDiscovery {
  discover(): Promise<readonly Project[]>;
}
