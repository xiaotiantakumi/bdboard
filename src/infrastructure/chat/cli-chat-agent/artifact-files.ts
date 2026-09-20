import { readFileSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { CliTurnContext, CliTurnPlan } from './types.js';

export function readArtifactFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * `target` が `directory` 配下(自身は含まない)であることを確認する。
 * 記号リンクは解決しない(scratchDir も lastMessageFile もこのプロセス自身が
 * 書いた一時ファイルパスであり、シンボリックリンク経由の攻撃面を想定していない)。
 */
export function isWithinDirectory(target: string, directory: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedDir = path.resolve(directory);
  const relative = path.relative(resolvedDir, resolvedTarget);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 一時ファイルの後始末。失敗してもターンは続行するが、ENOENT以外は警告する。
 * 呼び出し前に `scratchDir` 配下であることを確認しているのを前提とする
 * (bdboard-l1t.4 SF8: spec のバグで scratchDir 外の任意パスが渡ってきても、
 * ここで無関係なファイルを消してしまわないようにするための防御)。
 */
export function cleanupArtifactFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // パスや内容はログへ出さない。片付けの失敗でターン自体も失敗させない。
      console.error('chat cli-chat-agent: failed to remove a temporary chat artifact');
    }
  }
}

/**
 * 一時ディレクトリの後始末。失敗してもターンは続行する。
 * 呼び出し前に `scratchDir` 配下であることを確認しているのを前提とする
 * (bdboard-l1t.4 SF8: spec のバグで scratchDir 外の任意パスが渡ってきても、
 * ここで無関係なディレクトリを消してしまわないようにするための防御)。
 * ファイル側の `cleanupArtifactFile` と違って ENOENT の判定を持たないのは、
 * `force: true` が「存在しない」を既に握り潰すため。
 */
export function cleanupArtifactDir(dirPath: string): void {
  try {
    rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // パスや内容はログへ出さない。片付けの失敗でターン自体も失敗させない。
    console.error('chat cli-chat-agent: failed to remove a temporary chat artifact directory');
  }
}

export function cleanupTurnFiles(
  plan: Pick<CliTurnPlan, 'lastMessageFile' | 'temporaryFiles' | 'temporaryDirs'>,
  ctx: CliTurnContext,
  agentId: string,
): void {
  const files = [
    ...(plan.lastMessageFile !== undefined ? [plan.lastMessageFile] : []),
    ...(plan.temporaryFiles ?? []),
  ];
  for (const filePath of new Set(files)) {
    if (isWithinDirectory(filePath, ctx.scratchDir)) {
      cleanupArtifactFile(filePath);
    } else {
      console.error(
        `chat cli-chat-agent: refusing to delete temporary file outside scratchDir (agent=${agentId}, scratchDir=${ctx.scratchDir}, file=${filePath})`,
      );
    }
  }
  for (const dirPath of new Set(plan.temporaryDirs ?? [])) {
    if (isWithinDirectory(dirPath, ctx.scratchDir)) {
      cleanupArtifactDir(dirPath);
    } else {
      console.error(
        `chat cli-chat-agent: refusing to delete temporary directory outside scratchDir (agent=${agentId}, scratchDir=${ctx.scratchDir}, dir=${dirPath})`,
      );
    }
  }
}
