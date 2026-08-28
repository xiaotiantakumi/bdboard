import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { ScannedProcess } from '../ports/process-scanner.js';

export interface ListedAgentProcess {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt?: Date;
  readonly projectId?: string;
  readonly projectName?: string;
}

/**
 * パス区切りの差を吸収する。**win32 でのみ**バックスラッシュをスラッシュへ寄せる。
 *
 * discover-projects の isExcluded (bdboard-4iw RS1 = bdboard-h7f) は同じ正規化を
 * プラットフォーム非依存で行っているが、あちらを許容できるのは over-match が
 * 「除外が増える」= 安全側だからで、ここは向きが逆になる (bdboard-9dm)。
 * matchesProject の over-match は所属判定が緩む方向で、POSIX 上で合法な
 * バックスラッシュ入りパス (例: '/home/a\\b') が '/home/a/b' に化けると
 * 別プロジェクトのプロセスが所属扱いされる。前例の正当化ロジックがそのままは
 * 効かないので、正規化は win32 に限定する。
 */
function canonicalizeSeparators(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.replaceAll('\\', '/') : value;
}

function normalizeRootPath(rootPath: string, platform: NodeJS.Platform): string {
  let normalized = rootPath;
  if (
    normalized.length > 1 &&
    (normalized.endsWith('/') || normalized.endsWith('\\'))
  ) {
    normalized = normalized.slice(0, -1);
  }
  return canonicalizeSeparators(normalized, platform);
}

function matchesProject(
  cwd: string,
  rootPath: string,
  platform: NodeJS.Platform,
): boolean {
  // UI ヒントが 'C:/Users/you/projects' 形を案内する以上、rootPath がスラッシュ形でも
  // cwd がバックスラッシュ形(Windows の実パス)でも境界判定が効く必要がある (bdboard-9dm)。
  const canonicalCwd = canonicalizeSeparators(cwd, platform);
  const canonicalRoot = normalizeRootPath(rootPath, platform);
  if (canonicalCwd === canonicalRoot) {
    return true;
  }
  return canonicalCwd.startsWith(`${canonicalRoot}/`);
}

function resolveProject(
  cwd: string,
  projects: readonly Project[],
  platform: NodeJS.Platform,
): Project | undefined {
  let best: { readonly project: Project; readonly matchedLength: number } | undefined;

  for (const project of projects) {
    if (!matchesProject(cwd, project.rootPath, platform)) {
      continue;
    }

    const matchedLength = normalizeRootPath(project.rootPath, platform).length;
    if (
      best === undefined ||
      matchedLength > best.matchedLength ||
      (matchedLength === best.matchedLength &&
        compareStrings(project.rootPath, best.project.rootPath) < 0)
    ) {
      best = { project, matchedLength };
    }
  }

  return best?.project;
}

export function listAgentProcesses(
  processes: readonly ScannedProcess[],
  cache: BoardCache,
  /** 区切り正規化の分岐を POSIX 上でもテストできるように注入可能にしてある (bdboard-9dm)。 */
  options?: { readonly platform?: NodeJS.Platform },
): readonly ListedAgentProcess[] {
  const platform = options?.platform ?? process.platform;
  const projects = cache.listProjects().map((entry) => entry.project);

  const listed: ListedAgentProcess[] = processes.map((proc) => {
    const project = resolveProject(proc.cwd, projects, platform);
    return {
      pid: proc.pid,
      command: proc.command,
      cwd: proc.cwd,
      ...(proc.startedAt !== undefined ? { startedAt: proc.startedAt } : {}),
      ...(project !== undefined
        ? {
            projectId: project.id,
            projectName: project.name,
          }
        : {}),
    };
  });

  listed.sort((a, b) => {
    const aResolved = a.projectName !== undefined;
    const bResolved = b.projectName !== undefined;
    if (aResolved !== bResolved) {
      return aResolved ? -1 : 1;
    }

    if (aResolved && bResolved) {
      const nameCmp = compareStrings(a.projectName!, b.projectName!);
      if (nameCmp !== 0) {
        return nameCmp;
      }
    }

    return a.pid - b.pid;
  });

  return listed;
}
