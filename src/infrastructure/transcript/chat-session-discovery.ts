import os from 'node:os';
import path from 'node:path';
import type { FileSystemPort, DirEntry } from '../../application/ports/file-system.js';
import type { ChatSessionDiscoveryPort, DiscoveredChatSession } from '../../application/ports/chat-session-discovery.js';
import {
  extractTranscriptIdentity,
  parseTranscriptTailMessages,
  type TranscriptIdentity,
} from '../../application/transcript/parse-transcript-messages.js';
import {
  ADOPT_SEED_MESSAGE_LIMIT,
  DISCOVERED_CHAT_SESSIONS_MAX,
  DISCOVERED_SESSION_PREVIEW_MAX_CHARS,
} from '../../domain/chat.js';
import type { Project } from '../../domain/project.js';
import { findProjectForDirName } from './transcript-dir-matching.js';

/* bdboard-81b: cursor-agent のセッション(~/.cursor/chats)は discovery 対象外。
   調査記録と見送り理由は bdboard-81b の bd comment を参照。 */

export interface ChatSessionDiscoveryOptions {
  readonly projectsDir?: string;
  /**
   * 先頭から読む量(bytes)。cwd/sessionId フィールドを持つ行を見つけるのに使うので、
   * 前置きが長いセッションでも拾えるだけの余裕を持たせる (bdboard-3tw.104.3 レビュー SF5)。
   */
  readonly headBytes?: number;
  readonly tailBytes?: number;
  /**
   * adopt 直後のシード(readAdoptSeedMessages)用に末尾から読む量(bytes)。プレビュー1件
   * 分の tailBytes より大きく取り、複数ターン分をシードできるようにする
   * (bdboard-3tw.104.3 レビュー M1)。
   */
  readonly adoptSeedBytes?: number;
}

function normalizeDirPath(value: string): string {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * トランスクリプトが記録した cwd が project の rootPath/aliasPaths のいずれかと
 * **完全一致**するか (前方一致ではない)。
 *
 * なぜ完全一致か(bdboard-3tw.104.3 レビュー MF3): worktree などサブディレクトリの cwd から
 * 起動されたセッションは、実測で過半数がここで除外される対象になる。それらは
 * `claude --resume <id>` 自体は cwd 不一致でも技術的には実行できてしまう
 * (2026-08-16 実証: メインチェックアウトから worktree 由来セッションを resume して
 * 応答が返ることを確認した)が、"別ディレクトリ文脈の継続" になってしまうため、
 * 技術的に可能でも一覧・resume 対象からは除外する方針を維持する。
 */
function cwdMatchesProject(cwd: string, project: Project): boolean {
  const normalizedCwd = normalizeDirPath(cwd);
  return [project.rootPath, ...project.aliasPaths].some(
    (candidate) => normalizeDirPath(candidate) === normalizedCwd,
  );
}

export function createFsChatSessionDiscovery(
  fs: FileSystemPort,
  options?: ChatSessionDiscoveryOptions,
): ChatSessionDiscoveryPort {
  const projectsDir = options?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const headBytes = options?.headBytes ?? 65536;
  const tailBytes = options?.tailBytes ?? 4096;
  const adoptSeedBytes = options?.adoptSeedBytes ?? 32768;

  async function resolveOwnedDirs(project: Project, allProjects: readonly Project[]): Promise<readonly string[]> {
    let entries: readonly DirEntry[];
    try { entries = await fs.readDir(projectsDir); } catch { return []; }
    return entries
      .filter((entry) => entry.isDirectory)
      .filter((entry) => findProjectForDirName(entry.name, allProjects)?.id === project.id)
      .map((entry) => entry.name);
  }

  const truncate = (text: string): string =>
    text.length <= DISCOVERED_SESSION_PREVIEW_MAX_CHARS
      ? text
      : text.slice(0, DISCOVERED_SESSION_PREVIEW_MAX_CHARS);

  async function readHead(filePath: string, size: number): Promise<string | undefined> {
    return fs.readRange(filePath, 0, Math.min(size, headBytes));
  }

  function firstPreviewFromHead(headText: string): string | undefined {
    const first = parseTranscriptTailMessages(headText, 0)[0];
    return first === undefined ? undefined : truncate(first.text);
  }

  async function lastPreview(filePath: string, size: number): Promise<string | undefined> {
    const length = Math.min(size, tailBytes);
    const text = await fs.readRange(filePath, Math.max(0, size - length), length);
    if (text === undefined) return undefined;
    const messages = parseTranscriptTailMessages(text, 1);
    const last = messages[messages.length - 1];
    return last === undefined ? undefined : truncate(last.text);
  }

  /**
   * project が所有するディレクトリ配下の *.jsonl を、軽量なメタデータ(パス・mtime)だけで
   * 列挙する。中身はまだ読まない (bdboard-3tw.104.3 レビュー SF5: mtime 降順ソート→上限件数へ
   * 切り詰め→生き残りだけ中身を読む、の順にして無駄な I/O を避けるため)。
   */
  async function listCandidates(
    project: Project,
    allProjects: readonly Project[],
  ): Promise<readonly { readonly filePath: string; readonly mtimeMs: number; readonly size: number }[]> {
    const candidates: { filePath: string; mtimeMs: number; size: number }[] = [];
    for (const dirName of await resolveOwnedDirs(project, allProjects)) {
      let entries: readonly DirEntry[];
      try { entries = await fs.readDir(path.join(projectsDir, dirName)); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(projectsDir, dirName, entry.name);
        const stat = await fs.stat(filePath);
        if (stat === undefined) continue;
        candidates.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates;
  }

  /**
   * 候補ファイルの中身を読み、cwd が project と完全一致する場合だけ identity を返す。
   * 一致しない/確認できない場合は undefined (fail-closed — 一覧にも adopt 検証にも使わせない)。
   */
  async function resolveVerifiedIdentity(
    filePath: string,
    size: number,
    project: Project,
  ): Promise<{ readonly identity: TranscriptIdentity; readonly headText: string } | undefined> {
    const headText = await readHead(filePath, size);
    if (headText === undefined) return undefined;
    const identity = extractTranscriptIdentity(headText);
    if (identity === undefined || !cwdMatchesProject(identity.cwd, project)) return undefined;
    return { identity, headText };
  }

  return {
    async listDiscoveredSessions(project, allProjects) {
      // bdboard-3tw.104.3 レビュー M2: 50件キャップは「所有権(cwd)を検証できた」セッション
      // に対して適用する。検証前の候補(listCandidates はディレクトリ名だけで拾った時点の
      // 未検証集合)に適用すると、mtime が新しい cwd 不一致セッション(worktree 由来など)が
      // 枠を埋め、本チェックアウトの有効なセッションを一覧から押し出してしまう。
      // そのため mtime 降順で1件ずつ検証し、検証を通過した件数が上限に達したら打ち切る
      // (全候補を毎回スキャンしない = SF5 の意図も両立)。
      const candidates = await listCandidates(project, allProjects);

      const results: DiscoveredChatSession[] = [];
      for (const candidate of candidates) {
        if (results.length >= DISCOVERED_CHAT_SESSIONS_MAX) break;

        const verified = await resolveVerifiedIdentity(candidate.filePath, candidate.size, project);
        if (verified === undefined) continue;

        const [firstMessagePreview, lastMessagePreview] = await Promise.all([
          Promise.resolve(firstPreviewFromHead(verified.headText)),
          lastPreview(candidate.filePath, candidate.size),
        ]);

        results.push({
          sessionId: verified.identity.sessionId,
          lastActivityAt: new Date(candidate.mtimeMs),
          ...(firstMessagePreview === undefined ? {} : { firstMessagePreview }),
          ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
        });
      }

      results.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      return results;
    },

    async verifySessionExists(project, allProjects, sessionId) {
      // sessionId はファイル名ではなくトランスクリプト内容由来 (MF3) なので、ファイル名からの
      // 逆引きはできない。所有ディレクトリ内の各ファイルの中身を確認して真偽を判定する。
      for (const candidate of await listCandidates(project, allProjects)) {
        const verified = await resolveVerifiedIdentity(candidate.filePath, candidate.size, project);
        if (verified?.identity.sessionId === sessionId) {
          return true;
        }
      }
      return false;
    },

    async readAdoptSeedMessages(project, allProjects, sessionId) {
      // verifySessionExists と同じ探索(所有ディレクトリ内の中身確認)を辿り、一致したら
      // 末尾(adoptSeedBytes 分)を読んでメッセージ化する。ライブセッションインデックス
      // (~/.claude/sessions/*.json)ではなく、discovery が既に確認済みのこのトランスクリプト
      // 自体から読むので、終了済みセッションでも 404 にならない(bdboard-3tw.104.3 レビュー M1)。
      for (const candidate of await listCandidates(project, allProjects)) {
        const verified = await resolveVerifiedIdentity(candidate.filePath, candidate.size, project);
        if (verified?.identity.sessionId !== sessionId) continue;

        const length = Math.min(candidate.size, adoptSeedBytes);
        const text = await fs.readRange(
          candidate.filePath,
          Math.max(0, candidate.size - length),
          length,
        );
        if (text === undefined) return [];
        return parseTranscriptTailMessages(text, ADOPT_SEED_MESSAGE_LIMIT);
      }
      return undefined;
    },
  };
}
