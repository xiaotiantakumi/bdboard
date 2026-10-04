import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ISSUE_DRAFT_MAX_JSON_BYTES, isDraftId, type IssueDraft } from '../../domain/issue-draft.js';
import { draftJsonBytes, serializeDraft } from '../../domain/issue-draft-size.js';
import { draftSchema } from './issue-draft-schema.js';
import { DRAFT_READ_RETRY_DELAYS_MS, createDraftFileReader, sleepForMs } from './issue-draft-file-reader.js';
import type {
  DraftListing,
  IssueDraftStoragePort,
  StoredDraftImage,
} from '../../application/ports/issue-draft-storage.js';

/**
 * ファイルシステム版の不具合報告下書きストア (bdboard-4y8q.1)。
 *
 * レイアウト: <baseDir>/<id>/draft.json と <baseDir>/<id>/images/<file>。
 * 下書きには手元限定の生ログ (errorTextRaw) や元チケットの本文が入るので、添付画像
 * (umask 任せ) には揃えず、ディレクトリは 0700・ファイルは 0600 を明示して作る
 * (docs/ISSUE-REPORTING.md 2節)。
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DRAFT_FILE = 'draft.json';
const IMAGES_DIR = 'images';
/** このストアが採番する画像のファイル名 (<epochMs>-<16桁hex>.<ext>)。.DS_Store などの迷い込んだファイルは画像に数えない。 */
const IMAGE_FILE_NAME_PATTERN = /^[0-9]{1,20}-[0-9a-f]{16}\.[a-z0-9]{1,8}$/;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function within(parent: string, target: string): boolean {
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return target.startsWith(withSep);
}

export interface FsIssueDraftStorageOptions {
  /** 読めない下書きを飛ばしたときの警告 (既定は console.warn)。中身は渡さない: 理由と id だけ。 */
  readonly warn?: (message: string) => void;
  /** 既定は process.platform。win32 でだけ EPERM/EACCES をファイル単位の一時的な失敗として再試行する (テストで分岐を通すために注入できる)。 */
  readonly platform?: NodeJS.Platform;
  /** draft.json の読み出しの再試行。待ち (ms) の並びと sleep を差し替えられる (テストは実時間を待たない)。 */
  readonly readRetry?: {
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
  };
}

/**
 * incomplete: あとで読めるかもしれない理由で飛ばした (未列挙のエラー、または再試行を使い切ったファイル単位の失敗)。
 * 受け取りの索引をキャッシュさせない印。
 */
type DraftRead =
  | { readonly kind: 'ok'; readonly draft: IssueDraft }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly reason: string; readonly incomplete: boolean };

export function createFsIssueDraftStorage(
  baseDir: string,
  options: FsIssueDraftStorageOptions = {},
): IssueDraftStoragePort {
  const resolvedBaseDir = path.resolve(baseDir);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const readRaw = createDraftFileReader({
    platform: options.platform ?? process.platform,
    delaysMs: options.readRetry?.delaysMs ?? DRAFT_READ_RETRY_DELAYS_MS,
    sleep: options.readRetry?.sleep ?? sleepForMs,
  });
  /** 同じ下書きの同じ理由は 1 回だけ警告する (一覧は画面から何度も呼ばれる)。 */
  const warned = new Set<string>();

  function warnUnusable(id: string, reason: string): void {
    const key = `${id}:${reason}`;
    if (warned.has(key)) return;
    warned.add(key);
    warn(`issue draft ${id} is skipped: ${reason}`);
  }

  /** id は呼び出し側が検証済みの前提だが、ここでも形とパス閉じ込めを確かめる (defense in depth)。 */
  function draftDir(id: string): string {
    if (!isDraftId(id)) throw new Error(`invalid issue draft id: ${id}`);
    const dir = path.resolve(resolvedBaseDir, id);
    if (!within(resolvedBaseDir, dir)) throw new Error(`issue draft path escapes base dir: ${id}`);
    return dir;
  }

  function imagesDir(id: string): string {
    return path.join(draftDir(id), IMAGES_DIR);
  }

  function imageFilePath(id: string, fileName: string): string {
    const dir = imagesDir(id);
    const target = path.resolve(dir, fileName);
    if (!within(dir, target)) throw new Error(`issue draft image path escapes images dir: ${fileName}`);
    return target;
  }

  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  }

  /**
   * 存在しない (missing) と、あるが使えない (unusable: 読めない・壊れている・id が食い違う) を
   * 分ける。使えない下書き 1 件のせいで一覧や受け取り全体を落とさない (ポートの約束)。
   */
  async function readDraftFile(id: string): Promise<DraftRead> {
    // 不正な id は読み取りの失敗ではなくプログラムの誤りなので、try の外で投げる。
    // 読み出しの errno の扱い (再試行・ファイル単位の飛ばし・恒久の飛ばし・未列挙の飛ばし) は issue-draft-file-reader.ts。
    const read = await readRaw(path.join(draftDir(id), DRAFT_FILE));
    if (read.kind !== 'ok') return read;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(read.raw);
    } catch {
      return { kind: 'unusable', reason: 'not valid JSON', incomplete: false };
    }
    const parsed = draftSchema.safeParse(parsedJson);
    if (!parsed.success) return { kind: 'unusable', reason: 'does not match the draft format', incomplete: false };
    // ファイル名の id と中身の id が食い違うものは、別の下書きとして扱わず読まない。
    if (parsed.data.id !== id) return { kind: 'unusable', reason: 'id does not match its directory', incomplete: false };
    return { kind: 'ok', draft: parsed.data };
  }

  /** 読んで、使えなければ警告 (同じ下書きの同じ理由は 1 回) を出す。list/scan と get の共通の入口。 */
  async function readAndReport(id: string): Promise<DraftRead> {
    const result = await readDraftFile(id);
    if (result.kind === 'unusable') warnUnusable(id, result.reason);
    return result;
  }

  async function scan(): Promise<DraftListing> {
    let names: string[];
    try {
      names = await fs.readdir(resolvedBaseDir);
    } catch (error) {
      if (isNotFound(error)) return { drafts: [], complete: true };
      throw error;
    }
    const results = await Promise.all(names.filter(isDraftId).map((name) => readAndReport(name)));
    const drafts: IssueDraft[] = [];
    let complete = true;
    for (const result of results) {
      if (result.kind === 'ok') drafts.push(result.draft);
      else if (result.kind === 'unusable' && result.incomplete) complete = false;
    }
    return { drafts, complete };
  }

  async function imageEntries(id: string): Promise<StoredDraftImage[]> {
    const dir = imagesDir(id);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const imageNames = names.filter((name) => IMAGE_FILE_NAME_PATTERN.test(name));
    const entries = await Promise.all(
      imageNames.map(async (name): Promise<StoredDraftImage | undefined> => {
        try {
          const stat = await fs.stat(path.join(dir, name));
          return stat.isFile() ? { fileName: name, byteLength: stat.size, createdAt: stat.mtime } : undefined;
        } catch (error) {
          // readdir のあとで消えた画像だけ飛ばす。EMFILE・EIO など、あとで通るかもしれないエラーを飛ばすと、
          // 画像の数を少なく数えて上限 (ISSUE_DRAFT_MAX_IMAGES) を超えて足せてしまう。投げる。
          if (isNotFound(error)) return undefined;
          throw error;
        }
      }),
    );
    return entries
      .filter((entry): entry is StoredDraftImage => entry !== undefined)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  return {
    async list() {
      return (await scan()).drafts;
    },

    scan,

    async get(id) {
      const result = await readAndReport(id);
      return result.kind === 'ok' ? result.draft : undefined;
    },

    async save(draft) {
      const dir = draftDir(draft.id);
      // 縮められる欄 (fitDraftToByteLimit) を削っても 200KB に収まらない下書き (題名・本文などの
      // 固定の欄が大きい) は、黙って書かずに断る。何も作らない (ディレクトリも一時ファイルも)。
      const bytes = draftJsonBytes(draft);
      if (bytes > ISSUE_DRAFT_MAX_JSON_BYTES) {
        throw new Error(
          `issue draft ${draft.id} is ${bytes} bytes as written, over the ${ISSUE_DRAFT_MAX_JSON_BYTES} byte limit: refusing to save`,
        );
      }
      await ensureDir(resolvedBaseDir);
      await ensureDir(dir);
      // 途中まで書いた draft.json を読ませないよう、同じディレクトリの一時ファイルへ書いて rename する。
      const temp = path.join(dir, `${DRAFT_FILE}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        // 200KB の上限は serializeDraft の長さで測っている。整形せず同じ文字列をそのまま書く。
        await fs.writeFile(temp, serializeDraft(draft), { flag: 'wx', mode: FILE_MODE });
        await fs.rename(temp, path.join(dir, DRAFT_FILE));
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
    },

    async countImages(id) {
      return (await imageEntries(id)).length;
    },

    async saveImage(id, extension, data) {
      const dir = imagesDir(id);
      await ensureDir(resolvedBaseDir);
      await ensureDir(draftDir(id));
      await ensureDir(dir);
      // ファイル名はサーバーが採番する (添付画像と同じ <epochMs>-<16桁hex>.<ext>)。衝突は念のためリトライ。
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const fileName = `${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`;
        const target = imageFilePath(id, fileName);
        try {
          await fs.writeFile(target, data, { flag: 'wx', mode: FILE_MODE });
          const stat = await fs.stat(target);
          return { fileName, byteLength: stat.size, createdAt: stat.mtime };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
      }
      throw new Error('failed to allocate a unique issue draft image file name');
    },

    listImages: (id) => imageEntries(id),

    async readImage(id, fileName) {
      const target = imageFilePath(id, fileName);
      try {
        return await fs.readFile(target);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
  };
}
