/**
 * bdboard-4y8q.9.3: 届いた issue のサービスのテスト用の fake と組み立て。
 * *-test-support.ts なので本番コードからの import は src/test-support-import-guard.test.ts が止める。
 */
import { vi } from 'vitest';
import type { StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';
import type { ExternalIssueSnapshotStoragePort } from '../ports/external-issue-snapshot-storage.js';
import type { ExternalIssue, ExternalIssueListResult } from '../ports/external-issue-source.js';
import { createExternalIssueService, type ExternalIssueService } from './external-issue-service.js';

export const REPO_SLUG = 'xiaotiantakumi/bdboard';
export const PROJECT_ROOT = '/example/projects/bdboard';
export const START = Date.parse('2026-10-06T00:00:00.000Z');
export const DAY_MS = 24 * 60 * 60 * 1000;

export function makeIssue(number: number, overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    number,
    title: `issue ${number}`,
    body: 'body text',
    bodyLength: 9,
    updatedAt: '2026-10-05T00:00:00Z',
    author: 'someone',
    authorAssociation: 'NONE',
    url: `https://github.com/${REPO_SLUG}/issues/${number}`,
    ...overrides,
  };
}

/** 本文を変えるときは全長 (コードポイント) も合わせる。 */
export function withBody(number: number, body: string, overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return makeIssue(number, { body, bodyLength: Array.from(body).length, ...overrides });
}

export function okListing(
  issues: readonly ExternalIssue[],
  extra: Partial<Extract<ExternalIssueListResult, { ok: true }>> = {},
): ExternalIssueListResult {
  return { ok: true, issues, pagesFetched: 1, truncatedByPageLimit: false, skippedLines: 0, ...extra };
}

/** scan / save / remove を失敗させられる in-memory の写しの保存先。保存のたびに structuredClone して、ディスクを模す。 */
export interface InMemorySnapshotStorage extends ExternalIssueSnapshotStoragePort {
  readonly files: Map<number, StoredExternalIssueSnapshot>;
  readonly saves: number[];
  readonly removes: number[];
  readonly unusable: Set<number>;
  failScan: Error | undefined;
  failSave: ((snapshot: StoredExternalIssueSnapshot) => Error | undefined) | undefined;
  failRemove: Error | undefined;
  /**
   * 次の scan の入口で止める (release するまで scan が戻らない)。entered は scan がそこに着いたとき解ける。
   * 同時の流れの順序を見るテスト用。
   */
  gateScan(): { readonly release: () => void; readonly entered: Promise<void> };
}

export function createInMemorySnapshotStorage(): InMemorySnapshotStorage {
  const files = new Map<number, StoredExternalIssueSnapshot>();
  const unusable = new Set<number>();
  let gate: { readonly wait: Promise<void>; readonly enter: () => void } | undefined;
  const storage: InMemorySnapshotStorage = {
    files,
    saves: [],
    removes: [],
    unusable,
    failScan: undefined,
    failSave: undefined,
    failRemove: undefined,
    gateScan() {
      let release: () => void = () => undefined;
      let enter: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      gate = { wait, enter };
      return { release, entered };
    },
    async scan() {
      if (gate !== undefined) {
        const pending = gate;
        gate = undefined;
        pending.enter();
        await pending.wait;
      }
      if (storage.failScan) throw storage.failScan;
      return {
        snapshots: [...files.values()].sort((a, b) => a.number - b.number).map((record) => structuredClone(record)),
        unusable: [...unusable].sort((a, b) => a - b),
      };
    },
    get(number) {
      const record = files.get(number);
      return Promise.resolve(record === undefined ? undefined : structuredClone(record));
    },
    save(snapshot) {
      const failure = storage.failSave?.(snapshot);
      if (failure) return Promise.reject(failure);
      files.set(snapshot.number, structuredClone(snapshot));
      unusable.delete(snapshot.number);
      storage.saves.push(snapshot.number);
      return Promise.resolve();
    },
    remove(number) {
      if (storage.failRemove) return Promise.reject(storage.failRemove);
      files.delete(number);
      unusable.delete(number);
      storage.removes.push(number);
      return Promise.resolve();
    },
  };
  return storage;
}

export interface Harness {
  readonly service: ExternalIssueService;
  readonly storage: InMemorySnapshotStorage;
  readonly source: { listOpenIssues: ReturnType<typeof vi.fn<() => Promise<ExternalIssueListResult>>> };
  readonly refReader: { listExternalRefs: ReturnType<typeof vi.fn<(root: string) => Promise<readonly string[]>>> };
  readonly warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  /** GitHub の open issue の一覧を差し替える。 */
  setIssues(issues: readonly ExternalIssue[], extra?: Partial<Extract<ExternalIssueListResult, { ok: true }>>): void;
  setListing(result: ExternalIssueListResult): void;
  /** bd の external_ref を差し替える。 */
  setRefs(refs: readonly string[]): void;
  advance(ms: number): void;
  nowIso(): string;
}

export function createHarness(
  initial: readonly ExternalIssue[] = [],
  storage: InMemorySnapshotStorage = createInMemorySnapshotStorage(),
): Harness {
  let nowMs = START;
  let listing: ExternalIssueListResult = okListing(initial);
  let refs: readonly string[] = [];
  const source = { listOpenIssues: vi.fn<() => Promise<ExternalIssueListResult>>(() => Promise.resolve(listing)) };
  const refReader = { listExternalRefs: vi.fn<(root: string) => Promise<readonly string[]>>(() => Promise.resolve(refs)) };
  const warn = vi.fn<(message: string) => void>();
  const service = createExternalIssueService({
    source,
    refReader,
    storage,
    projectRootPath: PROJECT_ROOT,
    repoSlug: REPO_SLUG,
    now: () => new Date(nowMs),
    warn,
  });
  return {
    service,
    storage,
    source,
    refReader,
    warn,
    setIssues(issues, extra) {
      listing = okListing(issues, extra);
    },
    setListing(result) {
      listing = result;
    },
    setRefs(next) {
      refs = next;
    },
    advance(ms) {
      nowMs += ms;
    },
    nowIso: () => new Date(nowMs).toISOString(),
  };
}
