import { discoverProjects } from '../../application/discovery/discover-projects.js';
import { stripTrailingSeparators } from '../../domain/scan-root-policy.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { ScanRootsConfigPort } from '../../application/ports/scan-roots-config.js';
import type {
  ProjectDiscovery,
  ProjectDiscoveryConfig,
} from '../../application/ports/project-discovery.js';
import { resolveDefaultScanRoots } from './default-scan-roots.js';
import { NodeFileSystem } from '../fs/node-file-system.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * BDBOARD_SCAN_DIR_LIMIT(1 スキャンあたりの訪問ディレクトリ数上限)を読む。
 * 正の整数のみ有効。不正値・未設定は undefined を返し、application 層の
 * DEFAULT_SCAN_DIR_LIMIT に委ねる。env 読みは infrastructure 層の責務(bdboard-bzd)。
 */
function readScanDirLimitFromEnv(): number | undefined {
  const raw = process.env.BDBOARD_SCAN_DIR_LIMIT;
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    return undefined;
  }
  return parsed;
}

export function createFsProjectDiscovery(
  config?: Partial<ProjectDiscoveryConfig>,
  deps?: {
    fs?: FileSystemPort;
    commandRunner?: CommandRunner;
    scanRootsConfigStore?: ScanRootsConfigPort;
    /** 走査打ち切り警告のロガー。未指定なら application 層の既定(console.warn)。 */
    logWarn?: (message: string) => void;
  },
): ProjectDiscovery {
  const excludePaths = config?.excludePaths;
  const maxDepth = config?.maxDepth;
  const maxDirectories = config?.maxDirectories ?? readScanDirLimitFromEnv();
  const explicitScanRoots = config?.scanRoots;

  const fs = deps?.fs ?? new NodeFileSystem();
  const commandRunner = deps?.commandRunner ?? new NodeCommandRunner();

  return {
    discover: async () => {
      const userConfig =
        explicitScanRoots === undefined
          ? await deps?.scanRootsConfigStore?.read()
          : undefined;
      const scanRoots =
        explicitScanRoots ??
        (userConfig?.scanRoots !== undefined && userConfig.scanRoots.length > 0
          ? userConfig.scanRoots
          : await resolveDefaultScanRoots(fs));
      // マージ前に末尾セパレータを正規化しておくと、'/a/' と '/a' の重複が Set で
      // 潰れる(bdboard-4iw N5)。discoverProjects 側の消費時正規化とは独立の最適化。
      const mergedExcludePaths =
        explicitScanRoots !== undefined || userConfig === undefined
          ? excludePaths
          : [
              ...new Set(
                [...(excludePaths ?? []), ...(userConfig?.excludePaths ?? [])].map(
                  stripTrailingSeparators,
                ),
              ),
            ];
      return discoverProjects({
        fs,
        commandRunner,
        config: { scanRoots, excludePaths: mergedExcludePaths, maxDepth, maxDirectories },
        logWarn: deps?.logWarn,
      });
    },
  };
}
