import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isDraftId, type IssueDraft } from '../../domain/issue-draft.js';
import type {
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

const envInfoSchema = z.object({
  bdboardVersion: z.string(),
  harnessVersion: z.string().optional(),
  os: z.string(),
  nodeVersion: z.string(),
  bdVersion: z.string().optional(),
  ghVersion: z.string().optional(),
});

const localOnlySchema = z.object({
  symptomRaw: z.string(),
  causeRaw: z.string(),
  preventionRaw: z.string(),
  errorTextRaw: z.string().optional(),
  errorTextHead: z.string().optional(),
  errorTextTail: z.string().optional(),
  errorTextTruncated: z.boolean(),
  agentNoteRaw: z.string().optional(),
  envInfo: envInfoSchema,
  foldedFingerprints: z.array(z.string()).optional(),
});

const occurredProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

const draftSchema = z.object({
  id: z.string().refine(isDraftId),
  kind: z.enum(['A', 'B', 'C']),
  fingerprint: z.string().min(1),
  title: z.string(),
  body: z.string(),
  titleEditedByUser: z.boolean(),
  bodyEditedByUser: z.boolean(),
  localOnly: localOnlySchema,
  occurredProjects: z.array(occurredProjectSchema),
  occurrenceCount: z.number().int().nonnegative(),
  firstOccurredAt: z.string(),
  lastOccurredAt: z.string(),
  status: z.enum(['pending', 'posted', 'dismissed']),
  dismissReason: z.string().optional(),
  issueNumber: z.number().int().optional(),
  issueUrl: z.string().optional(),
  sourceTicketRef: z.string().optional(),
  harnessVersionAtOccurrence: z.string().optional(),
  draftSchemaVersion: z.literal(1),
});

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function within(parent: string, target: string): boolean {
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return target.startsWith(withSep);
}

export function createFsIssueDraftStorage(baseDir: string): IssueDraftStoragePort {
  const resolvedBaseDir = path.resolve(baseDir);

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

  async function readDraftFile(id: string): Promise<IssueDraft | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(draftDir(id), DRAFT_FILE), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = draftSchema.safeParse(parsedJson);
    // ファイル名の id と中身の id が食い違うものは、別の下書きとして扱わず読まない。
    return parsed.success && parsed.data.id === id ? parsed.data : undefined;
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
    const entries = await Promise.all(
      names.map(async (name): Promise<StoredDraftImage | undefined> => {
        try {
          const stat = await fs.stat(path.join(dir, name));
          return stat.isFile() ? { fileName: name, byteLength: stat.size, createdAt: stat.mtime } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return entries
      .filter((entry): entry is StoredDraftImage => entry !== undefined)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  return {
    async list() {
      let names: string[];
      try {
        names = await fs.readdir(resolvedBaseDir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const drafts = await Promise.all(names.filter(isDraftId).map((name) => readDraftFile(name)));
      return drafts.filter((draft): draft is IssueDraft => draft !== undefined);
    },

    get: (id) => readDraftFile(id),

    async save(draft) {
      const dir = draftDir(draft.id);
      await ensureDir(resolvedBaseDir);
      await ensureDir(dir);
      // 途中まで書いた draft.json を読ませないよう、同じディレクトリの一時ファイルへ書いて rename する。
      const temp = path.join(dir, `${DRAFT_FILE}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await fs.writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx', mode: FILE_MODE });
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
