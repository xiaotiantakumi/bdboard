import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_HARNESS_MANIFEST, type HarnessManifest } from '../../../domain/harness-pack.js';
import {
  gitignorePackSkillDirEntry,
  MANIFEST_RELATIVE_PATH,
  normalizeProjectRelativePath,
  resolveUnderClaudeDir,
} from '../../../domain/harness-path.js';
import { parseManifest } from './manifest.js';

/**
 * uninject の「消してよいものか」の検査 (bdboard-l1m1.7)。注入記録は人が書き換えられるし、
 * 注入後に `.claude/skills/<pack>` を別の場所へのシンボリックリンクに替える人もいる。
 * 記録の文字列だけを信じて unlink すると、リンク先のユーザー自身のファイルを消す。
 */

export interface PathProblem {
  readonly code: 'unsafe-path';
  readonly reason: string;
}

/** `relativeDir` (プロジェクトルートからの相対) の各階層を lstat し、最初のシンボリックリンクを返す。 */
export async function findSymlinkOnPath(
  projectRootPath: string,
  relativeDir: string,
): Promise<string | null> {
  const segments = relativeDir.split('/').filter((segment) => segment.length > 0);
  let current = '';
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    try {
      const stat = await fs.promises.lstat(path.join(projectRootPath, current));
      if (stat.isSymbolicLink()) {
        return current;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  return null;
}

export interface CheckedFile {
  readonly relativePath: string;
  readonly exists: boolean;
}

/**
 * 記録された各ファイルを検査する。
 * - `.claude/skills/<pack>/` の内側のパスだけを認める (記録が `.claude/agents/…` など
 *   他の場所を指していれば拒否)。
 * - `.claude`・`.claude/skills`・`.claude/skills/<pack>`・各ファイルの親ディレクトリに
 *   シンボリックリンクがあれば拒否する (リンク先を消さない)。
 * - 記録されたパスがディレクトリに替わっていれば拒否する (unlink できず、再実行しても同じ所で
 *   失敗するため、何も変える前にここで止める)。
 */
export async function checkRecordedFiles(
  projectRootPath: string,
  packName: string,
  recorded: readonly string[],
): Promise<{ files: readonly CheckedFile[] } | PathProblem> {
  const packDirEntry = gitignorePackSkillDirEntry(packName);
  if (packDirEntry === null) {
    return { code: 'unsafe-path', reason: `パック名が安全ではありません: ${packName}` };
  }

  const files: CheckedFile[] = [];
  for (const raw of recorded) {
    const relativePath = normalizeProjectRelativePath(raw);
    const absolute = resolveUnderClaudeDir(projectRootPath, raw);
    if (relativePath === null || absolute === null || !relativePath.startsWith(packDirEntry)) {
      return {
        code: 'unsafe-path',
        reason: `注入記録に ${packDirEntry} の外を指すパスがあります: ${raw} (記録を直してから外してください)`,
      };
    }

    const link = await findSymlinkOnPath(projectRootPath, path.posix.dirname(relativePath));
    if (link !== null) {
      return {
        code: 'unsafe-path',
        reason: `${link} がシンボリックリンクです。リンク先のファイルを消さないため、スクリプトでは外しません (リンクを自分で外してから実行してください)`,
      };
    }

    try {
      const stat = await fs.promises.lstat(absolute);
      if (stat.isDirectory()) {
        return {
          code: 'unsafe-path',
          reason: `注入記録のファイル ${relativePath} がディレクトリになっています。中身を確かめて自分で片付けてから実行してください (何も変更していません)`,
        };
      }
      files.push({ relativePath, exists: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      files.push({ relativePath, exists: false });
    }
  }
  return { files };
}

export type ManifestRead =
  | { readonly kind: 'ok'; readonly manifest: HarnessManifest }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * 注入記録の厳格な読み取り。ファイルが無ければ空の記録 (`ok`)。あるのに JSON として読めない・
 * 形が違うときは `unreadable` にする (`readManifestFromDisk` は読めないものを空として扱うので、
 * 「注入記録にありません」と誤解させる)。
 */
export async function readManifestStrict(projectRootPath: string): Promise<ManifestRead> {
  const absolute = resolveUnderClaudeDir(projectRootPath, MANIFEST_RELATIVE_PATH);
  if (absolute === null) {
    return { kind: 'unreadable', reason: '注入記録のパスが .claude/ の外を指しています' };
  }
  let content: string;
  try {
    content = await fs.promises.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', manifest: EMPTY_HARNESS_MANIFEST };
    }
    return { kind: 'unreadable', reason: `${MANIFEST_RELATIVE_PATH} を読めません: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: 'unreadable', reason: `${MANIFEST_RELATIVE_PATH} を JSON として読めません (壊れています。何も変更していません)` };
  }
  const packs = (parsed as { packs?: unknown } | null)?.packs;
  if (!Array.isArray(packs)) {
    return { kind: 'unreadable', reason: `${MANIFEST_RELATIVE_PATH} の形が不正です (packs 配列がありません。何も変更していません)` };
  }
  return { kind: 'ok', manifest: parseManifest(content) };
}
