import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExternalIssueSnapshotStoragePort } from '../../application/ports/external-issue-snapshot-storage.js';
import { isExternalIssueNumber, type StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';
import { externalIssueSnapshotSchema } from './external-issue-snapshot-schema.js';

/**
 * ファイルシステム版の「届いた issue」の写しの保存先 (bdboard-4y8q.9.3)。
 *
 * レイアウト: <baseDir>/<number>.json。写しには第三者が書いた文章 (題名・本文) が入るので、ディレクトリは 0700・
 * ファイルは 0600 を明示して作る (umask 任せにしない)。書くときは同じディレクトリの一時ファイルへ書いて rename する。
 * number は `^[1-9][0-9]{0,9}$` の形だけを受け付け、ファイル名もその形だけを読む (パスは番号からしか組まない)。
 * コメントは取り込まない。
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** 読むファイル名。番号の形 (EXTERNAL_ISSUE_NUMBER_PATTERN) に `.json` を付けたものだけ。一時ファイル (`*.tmp`) や迷い込んだファイルは読まない。 */
const SNAPSHOT_FILE_PATTERN = /^([1-9][0-9]{0,9})\.json$/;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** 読んだ結果。使えない (JSON でない・形が合わない・番号が食い違う・ディレクトリ) ものは理由つきで区別する。 */
type SnapshotRead =
  | { readonly kind: 'ok'; readonly snapshot: StoredExternalIssueSnapshot }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly reason: string };

export interface FsExternalIssueSnapshotStorageOptions {
  /** 使えない写しを飛ばしたときの警告 (既定は console.warn)。中身は渡さない: 理由と番号だけ。 */
  readonly warn?: (message: string) => void;
}

export function createFsExternalIssueSnapshotStorage(
  baseDir: string,
  options: FsExternalIssueSnapshotStorageOptions = {},
): ExternalIssueSnapshotStoragePort {
  const resolvedBaseDir = path.resolve(baseDir);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  /** 同じ番号の同じ理由は 1 回だけ警告する (一覧は定期的に読み直す)。 */
  const warned = new Set<string>();

  /** 番号の形は呼び出し側が守る前提だが、ここでも確かめる。外れた値はプログラムの誤りなので投げる。 */
  function fileOf(number: number): string {
    if (!isExternalIssueNumber(number)) throw new Error(`invalid external issue number: ${String(number)}`);
    return path.join(resolvedBaseDir, `${number}.json`);
  }

  async function readOne(number: number): Promise<SnapshotRead> {
    let raw: string;
    try {
      raw = await fs.readFile(fileOf(number), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
      // ディレクトリなどが居座っているのは恒久の状態で、読み取りの一時的な失敗ではない。それ以外 (権限・EIO ほか) は投げる。
      if (errorCode(error) === 'EISDIR') return { kind: 'unusable', reason: 'is a directory' };
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: 'unusable', reason: 'not valid JSON' };
    }
    const parsed = externalIssueSnapshotSchema.safeParse(json);
    if (!parsed.success) return { kind: 'unusable', reason: 'does not match the snapshot format' };
    if (parsed.data.number !== number) return { kind: 'unusable', reason: 'number does not match its file name' };
    return { kind: 'ok', snapshot: parsed.data };
  }

  async function readAndReport(number: number): Promise<SnapshotRead> {
    const result = await readOne(number);
    if (result.kind === 'unusable') {
      const key = `${number}:${result.reason}`;
      if (!warned.has(key)) {
        warned.add(key);
        warn(`external issue snapshot ${number} is skipped: ${result.reason}`);
      }
    }
    return result;
  }

  /** 番号の昇順に全ファイルを読み、読めた写しと、ファイルはあるが使えない番号 (`listUnusable`) に分ける。 */
  async function scan(): Promise<{ readonly snapshots: StoredExternalIssueSnapshot[]; readonly unusable: number[] }> {
    let names: string[];
    try {
      names = await fs.readdir(resolvedBaseDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { snapshots: [], unusable: [] };
      throw error;
    }
    const numbers = names
      .map((name) => SNAPSHOT_FILE_PATTERN.exec(name)?.[1])
      .filter((text): text is string => text !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const snapshots: StoredExternalIssueSnapshot[] = [];
    const unusable: number[] = [];
    // 最大でも数百件の小さなファイルなので、1 件ずつ読む (同時に開くファイルの数を抑える)。
    for (const number of numbers) {
      const result = await readAndReport(number);
      if (result.kind === 'ok') snapshots.push(result.snapshot);
      else if (result.kind === 'unusable') unusable.push(number);
    }
    return { snapshots, unusable };
  }

  return {
    async list() {
      return (await scan()).snapshots;
    },

    async listUnusable() {
      return (await scan()).unusable;
    },

    async get(number) {
      const result = await readAndReport(number);
      return result.kind === 'ok' ? result.snapshot : undefined;
    },

    async save(snapshot) {
      const file = fileOf(snapshot.number);
      // 余分な欄 (呼び出し側の都合の欄) を保存に紛れ込ませず、形の合わない記録は書かずに投げる。
      const record = externalIssueSnapshotSchema.parse(snapshot);
      await fs.mkdir(resolvedBaseDir, { recursive: true, mode: DIR_MODE });
      // 途中まで書いたファイルを読ませないよう、同じディレクトリの一時ファイルへ書いて rename する。
      const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: FILE_MODE });
        await fs.rename(temp, file);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async remove(number) {
      await fs.rm(fileOf(number), { force: true });
    },
  };
}
