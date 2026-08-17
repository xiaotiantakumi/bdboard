import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../domain/project.js';
import { DISCOVERED_CHAT_SESSIONS_MAX } from '../../domain/chat.js';
import type { DirEntry, FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import { encodeCwdForTranscript } from '../../application/session/parse-session-file.js';
import { createFsChatSessionDiscovery } from './chat-session-discovery.js';

const projectsDir = '/fake/projects';
const project = (id: string, rootPath: string): Project => ({ id, name: id, rootPath, prefixes: [], aliasPaths: [] });
const dir = (name: string): DirEntry => ({ name, isDirectory: true, isSymbolicLink: false });
const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymbolicLink: false });

function fakeFs(dirs: Record<string, readonly DirEntry[]>, contents: Record<string, string>, stats: Record<string, FileStat> = {}) {
  const readRangePaths: string[] = [];
  const fs: FileSystemPort = {
    async readDir(p) { const entries = dirs[p]; if (entries === undefined) throw new Error('ENOENT'); return entries; },
    async isDirectory(p) { return dirs[p] !== undefined; }, async realPath(p) { return p; },
    async stat(p) { return stats[p] ?? (contents[p] === undefined ? undefined : { size: Buffer.byteLength(contents[p]), mtimeMs: 1 }); },
    async readFile(p) { return contents[p]; },
    async readRange(p, start, length) { readRangePaths.push(p); return contents[p]?.slice(start, start + length); },
    async readRangeBytes(p, start, length) { const value = contents[p]; return value === undefined ? undefined : Buffer.from(value).subarray(start, start + length); },
  };
  return { fs, readRangePaths };
}

// cwd/sessionId をトランスクリプト本体に埋め込む (MF3: ファイル名ではなく中身から真偽を判定する)。
const transcript = (cwd: string, sessionId: string, first: string, last: string): string => [
  JSON.stringify({ type: 'user', message: { content: first }, cwd, sessionId }),
  JSON.stringify({ type: 'assistant', message: { content: last }, cwd, sessionId }),
].join('\n');

describe('createFsChatSessionDiscovery', () => {
  it('discovers top-level sessions using the transcript-embedded sessionId/cwd, ignoring subagents', async () => {
    const p = project('p1', '/work/app');
    const encoded = encodeCwdForTranscript(p.rootPath);
    const dirPath = path.join(projectsDir, encoded);
    // ファイル名は 'local_session-1' だが、中身の sessionId は別物。結果はファイル名ではなく
    // 中身の sessionId を返すことを確認する (MF3 の核心)。
    const sessionPath = path.join(dirPath, 'local_session-1.jsonl');
    const data = transcript(p.rootPath, 'true-session-id', 'first message', 'last message');
    const { fs } = fakeFs(
      { [projectsDir]: [dir(encoded)], [dirPath]: [file('local_session-1.jsonl'), dir('subagents')] },
      { [sessionPath]: data },
      { [sessionPath]: { size: Buffer.byteLength(data), mtimeMs: 42 } },
    );
    const result = await createFsChatSessionDiscovery(fs, { projectsDir }).listDiscoveredSessions(p, [p]);
    expect(result).toEqual([
      { sessionId: 'true-session-id', lastActivityAt: new Date(42), firstMessagePreview: 'first message', lastMessagePreview: 'last message' },
    ]);
  });

  it('excludes a session whose cwd is a subdirectory of the project root (not an exact match)', async () => {
    const p = project('p1', '/work/app');
    const encoded = encodeCwdForTranscript(p.rootPath);
    const dirPath = path.join(projectsDir, encoded);
    const sessionPath = path.join(dirPath, 'sess.jsonl');
    // cwd はプロジェクト配下だが完全一致ではない (例: worktree のサブディレクトリで launch した)。
    const data = transcript(`${p.rootPath}/some/nested/dir`, 'nested-session', 'a', 'b');
    const { fs } = fakeFs(
      { [projectsDir]: [dir(encoded)], [dirPath]: [file('sess.jsonl')] },
      { [sessionPath]: data },
      { [sessionPath]: { size: Buffer.byteLength(data), mtimeMs: 1 } },
    );
    const result = await createFsChatSessionDiscovery(fs, { projectsDir }).listDiscoveredSessions(p, [p]);
    expect(result).toEqual([]);
  });

  it('exact-matches an aliasPath (worktree folded into the project) too', async () => {
    const p: Project = { id: 'p1', name: 'p1', rootPath: '/work/app', prefixes: [], aliasPaths: ['/work/app-worktree'] };
    const encoded = encodeCwdForTranscript('/work/app-worktree');
    const dirPath = path.join(projectsDir, encoded);
    const sessionPath = path.join(dirPath, 'sess.jsonl');
    const data = transcript('/work/app-worktree', 'worktree-session', 'a', 'b');
    const { fs } = fakeFs(
      { [projectsDir]: [dir(encoded)], [dirPath]: [file('sess.jsonl')] },
      { [sessionPath]: data },
      { [sessionPath]: { size: Buffer.byteLength(data), mtimeMs: 1 } },
    );
    const result = await createFsChatSessionDiscovery(fs, { projectsDir }).listDiscoveredSessions(p, [p]);
    expect(result.map((s) => s.sessionId)).toEqual(['worktree-session']);
  });

  it('excludes a directory-name false positive (e.g. an "-old" suffix dir) whose content cwd does not match', async () => {
    const p = project('p1', '/work/app');
    const encoded = encodeCwdForTranscript(p.rootPath);
    // findProjectForDirName の前方一致ルールにより、このディレクトリは (中身を見なければ) p1 の
    // ものだと誤認識されうる。中身の cwd 検証で実害が消えることを確認する。
    const trapDirName = `${encoded}-old`;
    const trapDirPath = path.join(projectsDir, trapDirName);
    const trapSessionPath = path.join(trapDirPath, 'sess.jsonl');
    const trapData = transcript('/completely/unrelated/backup', 'trap-session', 'a', 'b');
    const { fs, readRangePaths } = fakeFs(
      { [projectsDir]: [dir(trapDirName)], [trapDirPath]: [file('sess.jsonl')] },
      { [trapSessionPath]: trapData },
      { [trapSessionPath]: { size: Buffer.byteLength(trapData), mtimeMs: 5 } },
    );
    const discovery = createFsChatSessionDiscovery(fs, { projectsDir });
    expect(await discovery.listDiscoveredSessions(p, [p])).toEqual([]);
    expect(await discovery.verifySessionExists(p, [p], 'trap-session')).toBe(false);
    // ディレクトリ名の照合で対象になった以上、中身は読みに行く (fail-closed の判定のため) が、
    // 結果としてそのセッションは一覧にも adopt 検証にも出てこないことが重要。
    expect(readRangePaths).toContain(trapSessionPath);
  });

  it('does not mix another project directory and verifies safely against path-traversal-like sessionIds', async () => {
    const p1 = project('p1', '/work/app'); const p2 = project('p2', '/work/other');
    const d1 = encodeCwdForTranscript(p1.rootPath); const d2 = encodeCwdForTranscript(p2.rootPath);
    const path1 = path.join(projectsDir, d1); const path2 = path.join(projectsDir, d2);
    const ownFile = path.join(path1, 'own.jsonl'); const otherFile = path.join(path2, 'other.jsonl');
    const ownData = transcript(p1.rootPath, 'own', 'own', 'own last');
    const otherData = transcript(p2.rootPath, 'other', 'other', 'other last');
    const { fs, readRangePaths } = fakeFs(
      { [projectsDir]: [dir(d1), dir(d2)], [path1]: [file('own.jsonl')], [path2]: [file('other.jsonl')] },
      { [ownFile]: ownData, [otherFile]: otherData },
    );
    const discovery = createFsChatSessionDiscovery(fs, { projectsDir });
    expect((await discovery.listDiscoveredSessions(p1, [p1, p2])).map((s) => s.sessionId)).toEqual(['own']);
    expect(await discovery.verifySessionExists(p1, [p1, p2], 'own')).toBe(true);
    expect(await discovery.verifySessionExists(p1, [p1, p2], 'other')).toBe(false);
    readRangePaths.length = 0;
    expect(await discovery.verifySessionExists(p1, [p1, p2], '../other')).toBe(false);
    expect(await discovery.verifySessionExists(p1, [p1, p2], '/etc/passwd')).toBe(false);
    // sessionId を直接パスへ連結しない設計なので、p1 が所有するディレクトリの外は一切読みに行かない。
    expect(readRangePaths.every((p) => p.startsWith(path1))).toBe(true);
  });

  it('sorts by mtime descending and caps the result at DISCOVERED_CHAT_SESSIONS_MAX', async () => {
    const p = project('p1', '/work/app');
    const encoded = encodeCwdForTranscript(p.rootPath);
    const dirPath = path.join(projectsDir, encoded);

    const total = DISCOVERED_CHAT_SESSIONS_MAX + 5;
    const entries: DirEntry[] = [];
    const contents: Record<string, string> = {};
    const stats: Record<string, FileStat> = {};
    for (let i = 0; i < total; i += 1) {
      const fileName = `sess-${i}.jsonl`;
      const filePath = path.join(dirPath, fileName);
      const data = transcript(p.rootPath, `sess-${i}`, 'a', 'b');
      entries.push(file(fileName));
      contents[filePath] = data;
      // mtime を sess-0 が最も新しく、sess-(total-1) が最も古くなるようにする。
      stats[filePath] = { size: Buffer.byteLength(data), mtimeMs: total - i };
    }

    const { fs } = fakeFs({ [projectsDir]: [dir(encoded)], [dirPath]: entries }, contents, stats);
    const result = await createFsChatSessionDiscovery(fs, { projectsDir }).listDiscoveredSessions(p, [p]);

    expect(result).toHaveLength(DISCOVERED_CHAT_SESSIONS_MAX);
    expect(result.map((s) => s.sessionId)).toEqual(
      Array.from({ length: DISCOVERED_CHAT_SESSIONS_MAX }, (_, i) => `sess-${i}`),
    );
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i - 1].lastActivityAt.getTime()).toBeGreaterThanOrEqual(result[i].lastActivityAt.getTime());
    }
  });

  it('caps AFTER cwd verification, so newer-mtime cwd-mismatched sessions cannot evict older valid ones (bdboard-3tw.104.3 レビュー M2)', async () => {
    const p = project('p1', '/work/app');
    const encoded = encodeCwdForTranscript(p.rootPath);
    const dirPath = path.join(projectsDir, encoded);

    const entries: DirEntry[] = [];
    const contents: Record<string, string> = {};
    const stats: Record<string, FileStat> = {};

    // 所有ディレクトリ名だけでは p1 のものと判定される (findProjectForDirName の前方一致) が、
    // 中身の cwd はサブディレクトリ(worktree 由来)で、cwdMatchesProject の完全一致に落ちる
    // 「不一致」セッションを、有効なセッションよりずっと新しい mtime で 5 件仕込む。
    const MISMATCH_COUNT = 5;
    for (let i = 0; i < MISMATCH_COUNT; i += 1) {
      const fileName = `mismatched-${i}.jsonl`;
      const filePath = path.join(dirPath, fileName);
      const data = transcript(`${p.rootPath}/worktree-${i}`, `mismatched-${i}`, 'a', 'b');
      entries.push(file(fileName));
      contents[filePath] = data;
      stats[filePath] = { size: Buffer.byteLength(data), mtimeMs: 100000 + i };
    }

    // cwd が完全一致する、有効なセッションをちょうど上限件数だけ、mismatch 群より
    // 古い mtime で仕込む。
    for (let i = 0; i < DISCOVERED_CHAT_SESSIONS_MAX; i += 1) {
      const fileName = `valid-${i}.jsonl`;
      const filePath = path.join(dirPath, fileName);
      const data = transcript(p.rootPath, `valid-${i}`, 'a', 'b');
      entries.push(file(fileName));
      contents[filePath] = data;
      stats[filePath] = { size: Buffer.byteLength(data), mtimeMs: DISCOVERED_CHAT_SESSIONS_MAX - i };
    }

    const { fs } = fakeFs({ [projectsDir]: [dir(encoded)], [dirPath]: entries }, contents, stats);
    const result = await createFsChatSessionDiscovery(fs, { projectsDir }).listDiscoveredSessions(p, [p]);

    // キャップ前に検証していれば、mtime 降順で先頭に来る mismatch 群がキャップ枠を
    // 消費し、最も古い有効セッションが押し出されて 50 件に満たなくなる。検証後に
    // キャップする実装ではそれが起きず、有効な 50 件すべてが残る。
    expect(result).toHaveLength(DISCOVERED_CHAT_SESSIONS_MAX);
    const sessionIds = result.map((s) => s.sessionId);
    expect(sessionIds.every((id) => id.startsWith('valid-'))).toBe(true);
    expect(sessionIds).toContain('valid-0');
    expect(sessionIds).toContain(`valid-${DISCOVERED_CHAT_SESSIONS_MAX - 1}`);
  });

  describe('readAdoptSeedMessages (bdboard-3tw.104.3 レビュー M1)', () => {
    it('returns the transcript tail messages for a cwd-verified session', async () => {
      const p = project('p1', '/work/app');
      const encoded = encodeCwdForTranscript(p.rootPath);
      const dirPath = path.join(projectsDir, encoded);
      const sessionPath = path.join(dirPath, 'sess.jsonl');
      const data = transcript(p.rootPath, 'seed-session', 'first message', 'last message');
      const { fs } = fakeFs(
        { [projectsDir]: [dir(encoded)], [dirPath]: [file('sess.jsonl')] },
        { [sessionPath]: data },
        { [sessionPath]: { size: Buffer.byteLength(data), mtimeMs: 1 } },
      );
      const discovery = createFsChatSessionDiscovery(fs, { projectsDir });
      const seed = await discovery.readAdoptSeedMessages(p, [p], 'seed-session');
      expect(seed).toBeDefined();
      expect(seed?.map((m) => m.text)).toEqual(['first message', 'last message']);
    });

    it('returns undefined for a sessionId that does not verify against this project (unknown or cwd-mismatched)', async () => {
      const p = project('p1', '/work/app');
      const encoded = encodeCwdForTranscript(p.rootPath);
      const dirPath = path.join(projectsDir, encoded);
      const sessionPath = path.join(dirPath, 'sess.jsonl');
      // cwd がサブディレクトリ(完全一致しない)なので resolveVerifiedIdentity は失敗する。
      const data = transcript(`${p.rootPath}/nested`, 'seed-session', 'first message', 'last message');
      const { fs } = fakeFs(
        { [projectsDir]: [dir(encoded)], [dirPath]: [file('sess.jsonl')] },
        { [sessionPath]: data },
        { [sessionPath]: { size: Buffer.byteLength(data), mtimeMs: 1 } },
      );
      const discovery = createFsChatSessionDiscovery(fs, { projectsDir });
      expect(await discovery.readAdoptSeedMessages(p, [p], 'seed-session')).toBeUndefined();
      expect(await discovery.readAdoptSeedMessages(p, [p], 'totally-unknown')).toBeUndefined();
    });
  });
});
