import type { ExternalIssueSnapshotStoragePort } from '../ports/external-issue-snapshot-storage.js';
import type {
  BdExternalRefReaderPort,
  ExternalIssue,
  ExternalIssueSourcePort,
} from '../ports/external-issue-source.js';
import { compareWithSnapshot } from '../../domain/external-issue-snapshot.js';
import {
  EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT,
  createSnapshotRecord,
  isExternalIssueNumber,
  prepareExternalIssue,
  selectSnapshotsToRemove,
  type PreparedExternalIssue,
  type StoredExternalIssueSnapshot,
} from '../../domain/external-issue-snapshot-record.js';
import { findUnlinkedIssues, linkedIssueNumbers, parseRepoSlug } from '../../domain/github-issue-link.js';
import {
  EMPTY_LIST,
  entryOf,
  errorName,
  storageDetail,
  summaryOf,
  type ExternalIssueEntry,
  type ExternalIssueList,
  type ExternalIssueListErrorKind,
  type ResnapshotResult,
} from './external-issue-list.js';
import { createMutex } from './issue-draft-mutex.js';

export type {
  ExternalIssueEntry,
  ExternalIssueList,
  ExternalIssueListErrorKind,
  ExternalIssueSnapshotSummary,
  ResnapshotResult,
} from './external-issue-list.js';

/**
 * 届いた issue (ほかの人が出した公開 issue) の一覧づくりと、判定時点の写しの保存 (bdboard-4y8q.9.3、
 * docs/ISSUE-REPORTING.md 8節)。
 *
 * このサービスが外へ出すのは gh の読み取り (`ExternalIssueSourcePort`) と bd の読み取り (`BdExternalRefReaderPort`) だけ。
 * GitHub への書き込みも、エージェントの呼び出しもしない (判定は 4y8q.10)。HTTP・定期実行の配線は 4y8q.9.4。
 */

export interface ExternalIssueService {
  /**
   * open の issue を読み、PR と bd に紐付いたものを除き、切り詰めて検査し、写しを残して一覧を更新する。
   * 同時に 1 本だけ流す: 実行中に呼ぶと、その実行の結果を返す (新しく始めない)。例外は投げない (失敗は `state: 'error'`)。
   */
  poll(): Promise<ExternalIssueList>;
  /** 直近の一覧 (メモリ)。 */
  getList(): ExternalIssueList;
  /**
   * 写しを、直近の一覧にある現在の内容で取り直す (needsRejudge を下ろす)。4y8q.10 の判定の直前に呼ぶ想定で、
   * HTTP には出さない。GitHub は読み直さない (呼び出し側が先に `poll` するかを決める)。
   */
  resnapshot(number: number): Promise<ResnapshotResult>;
}

export interface ExternalIssueServiceOptions {
  readonly source: ExternalIssueSourcePort;
  readonly refReader: BdExternalRefReaderPort;
  readonly storage: ExternalIssueSnapshotStoragePort;
  /** bdboard 自身の bd のプロジェクトのルート (external_ref を読む先)。 */
  readonly projectRootPath: string;
  /** 読む対象のリポジトリ (`owner/repo`)。external_ref の紐付けの判定に使う。 */
  readonly repoSlug: string;
  readonly now?: () => Date;
  /** 古い写しを消せなかったときの警告 (既定は console.warn)。 */
  readonly warn?: (message: string) => void;
}

export function createExternalIssueService(options: ExternalIssueServiceOptions): ExternalIssueService {
  const { source, refReader, storage, projectRootPath } = options;
  const repoSlug = parseRepoSlug(options.repoSlug);
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  /** 写しの読み書きと一覧の差し替えを 1 本ずつ流す (poll と resnapshot が、読んだ写しを古いまま上書きし合わないため)。 */
  const lock = createMutex();
  let latest: ExternalIssueList = EMPTY_LIST;
  let inFlight: Promise<ExternalIssueList> | undefined;

  /** 直近の成功の一覧は残して、止まった理由だけを足す。 */
  function failWith(kind: ExternalIssueListErrorKind, detail: string): ExternalIssueList {
    latest = { ...latest, state: 'error', error: { kind, detail } };
    return latest;
  }

  /** 一覧に載る issue ごとに写しを作る・比べる。書いた記録 (または、変えなかった記録) を番号で返す。 */
  async function syncListed(
    listed: readonly { readonly issue: ExternalIssue; readonly prepared: PreparedExternalIssue }[],
    stored: ReadonlyMap<number, StoredExternalIssueSnapshot>,
    nowIso: string,
  ): Promise<{ readonly entries: ExternalIssueEntry[]; readonly records: Map<number, StoredExternalIssueSnapshot> }> {
    const entries: ExternalIssueEntry[] = [];
    const records = new Map(stored);
    for (const { issue, prepared } of listed) {
      const existing = stored.get(issue.number);
      let record: StoredExternalIssueSnapshot;
      if (existing === undefined) {
        // 最初に見た時点の内容を、判定時点の写しの初期値として残す。
        record = createSnapshotRecord(prepared, nowIso);
        await storage.save(record);
      } else {
        // 比べる相手は取り直すまで最初の写し。印は一度立てたら下ろさない。書くのは変わったときだけ (毎回は書かない)。
        const needsRejudge = existing.needsRejudge || compareWithSnapshot(existing, prepared).needsRejudge;
        if (needsRejudge !== existing.needsRejudge || existing.missingSince !== null) {
          record = { ...existing, needsRejudge, missingSince: null };
          await storage.save(record);
        } else {
          record = existing;
        }
      }
      records.set(issue.number, record);
      entries.push(entryOf(issue, prepared, record));
    }
    return { entries, records };
  }

  /** 一覧に載らなくなった写しに、外れた時刻を付ける (載っていたあいだは null)。外れた最初の確認の 1 回だけ書く。 */
  async function markMissing(
    records: Map<number, StoredExternalIssueSnapshot>,
    listedNumbers: ReadonlySet<number>,
    nowIso: string,
  ): Promise<void> {
    for (const record of [...records.values()]) {
      if (listedNumbers.has(record.number) || record.missingSince !== null) continue;
      const marked = { ...record, missingSince: nowIso };
      await storage.save(marked);
      records.set(record.number, marked);
    }
  }

  /** 保持期限と上限を超えた写しを消す。消せなくても確認は失敗にしない (写しは書けている。次の確認でまた試す)。 */
  async function prune(records: ReadonlyMap<number, StoredExternalIssueSnapshot>, nowMs: number, listingComplete: boolean): Promise<void> {
    for (const number of selectSnapshotsToRemove([...records.values()], { nowMs, listingComplete })) {
      try {
        await storage.remove(number);
      } catch (error) {
        warn(`external issue snapshot ${number} could not be removed: ${storageDetail('remove failed', error)}`);
      }
    }
  }

  async function commit(
    open: readonly ExternalIssue[],
    truncated: boolean,
    skippedLines: number,
  ): Promise<ExternalIssueList> {
    const nowDate = now();
    const nowIso = nowDate.toISOString();
    let stored: readonly StoredExternalIssueSnapshot[];
    try {
      stored = await storage.list();
    } catch (error) {
      return failWith('storage-failed', storageDetail('could not read the saved snapshots', error));
    }
    // 切り詰め → 検査は、写しの比較・保存より前。検査にも保存にも、切った先の文字列は渡らない。
    const listed = open.map((issue) => ({ issue, prepared: prepareExternalIssue(issue) }));
    let entries: ExternalIssueEntry[];
    let records: Map<number, StoredExternalIssueSnapshot>;
    try {
      ({ entries, records } = await syncListed(listed, new Map(stored.map((record) => [record.number, record])), nowIso));
      // 一覧が最後まで読めていないときは、載っていない issue がまだ open かもしれないので、外れた印は付けない。
      if (!truncated) await markMissing(records, new Set(open.map((issue) => issue.number)), nowIso);
    } catch (error) {
      // 1 件でも写しを残せなかったら、一覧は前回のまま (一覧に載るものは必ず写しがある、を崩さない)。
      return failWith('storage-failed', storageDetail('could not save a snapshot', error));
    }
    await prune(records, nowDate.getTime(), !truncated);
    latest = { state: 'ok', fetchedAt: nowIso, issues: entries, error: null, truncated, skippedLines };
    return latest;
  }

  async function run(): Promise<ExternalIssueList> {
    try {
      const listed = await source.listOpenIssues();
      if (!listed.ok) return failWith(listed.kind, listed.detail);
      let refs: readonly string[];
      try {
        refs = await refReader.listExternalRefs(projectRootPath);
      } catch {
        // 紐付いたものを除けないので、一覧は作らない (紐付いた issue が並んでしまう)。
        return failWith('bd-failed', 'could not read the external refs from bd');
      }
      // 写しのファイル名にできない番号 (`^[1-9][0-9]{0,9}$` の外) は、1 件のために一覧全体を storage-failed で止めないよう、
      // 読めなかった行として数えて除く。
      const numbered = listed.issues.filter((issue) => isExternalIssueNumber(issue.number));
      const skippedLines = listed.skippedLines + (listed.issues.length - numbered.length);
      // PR は gh の読み取りの段階で除かれている (`ExternalIssue` は PR を含まない)。ここでは bd に紐付いたものを除く。
      const unlinked = findUnlinkedIssues(numbered, linkedIssueNumbers(refs, repoSlug));
      const capped = unlinked.length > EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT;
      const open = capped ? unlinked.slice(0, EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT) : unlinked;
      return await lock(() => commit(open, listed.truncatedByPageLimit || capped, skippedLines));
    } catch (error) {
      // 黙って捨てず、ログには例外の種類 (name) だけを残す。message・stack には第三者の文章やパスが入りうるので出さない。
      warn(`external issue poll failed unexpectedly: ${errorName(error)}`);
      return failWith('unexpected', 'unexpected error while checking for incoming issues');
    }
  }

  return {
    poll() {
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    getList: () => latest,

    resnapshot(number) {
      return lock(async (): Promise<ResnapshotResult> => {
        const entry = latest.issues.find((candidate) => candidate.number === number);
        if (entry === undefined) return { ok: false, reason: 'not-listed' };
        const record = createSnapshotRecord(entry, now().toISOString());
        try {
          await storage.save(record);
        } catch {
          return { ok: false, reason: 'storage-failed' };
        }
        // 保存を待つあいだに failWith が error 欄を差し替えうるので、保存後の最新の一覧に写しの要約だけを反映する。
        latest = {
          ...latest,
          issues: latest.issues.map((candidate) =>
            candidate.number === number ? { ...candidate, snapshot: summaryOf(record, candidate.updatedAt) } : candidate,
          ),
        };
        return { ok: true, snapshot: record };
      });
    },
  };
}
