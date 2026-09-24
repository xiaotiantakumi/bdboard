import type { ApplicationVersionProvider } from '../../application/ports/application-version.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { ProcessScanner } from '../../application/ports/process-scanner.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import type { ResolvedBoardThresholds } from '../../domain/board-thresholds.js';
import type { HygieneThresholds } from '../../domain/hygiene.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { PrBadgeStatusCache } from '../../application/board/get-pr-badges.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import type { ReclaimHistory } from '../../application/lease/reclaim-history.js';
import type { AgentSession, SessionLink } from '../../domain/session.js';
import type { EventHub } from '../sse/event-hub.js';
import type { WriteGuardDeps } from './write-guard.js';

// bdboard-tml8: ApiStatus/ApiDeps を routes.ts から抜き出した専用ファイル。
// 各ルートグループのファイルはこの型だけを直接 import する (routes.ts 経由にしない)。
// 各グループのファイルは ApiDeps を type-only import する一方、routes.ts はその
// グループのファイル自体を(ルーター組み立てのため)値として import する。両方を
// routes.ts 経由にすると「routes.ts <-> 各グループ」の型だけの import 循環になり、
// dependency-cruiser の no-circular に引っかかる(このチケットの本題)。routes.ts は
// 引き続き `export type { ApiStatus, ApiDeps } from './api-deps.js'` で
// 外部 (bootstrap 等) 向けの公開経路を保つ。

export interface ApiStatus {
  readonly lastRefreshAt: Date | null;
  readonly errors: readonly { kind: string; projectId: string; detail: string }[];
  readonly projectCount: number;
}

export interface ApiDeps {
  readonly cache: BoardCache;
  readonly applicationVersion: ApplicationVersionProvider;
  /** e2e 等 per-run 識別子。未設定時は /api/health に含めない (通常運用の応答形を維持)。 */
  readonly instanceNonce?: string;
  readonly now: () => Date;
  readonly getStatus: () => ApiStatus;
  readonly refresh: () => Promise<void>;
  /**
   * 指定した rootPath のプロジェクトだけを強制リフレッシュする(bdboard-6qs6)。
   * 書き込みルートが応答を返す前にこれを await することで、UI が書き込み直後に
   * 再取得しても陳腐化したキャッシュを掴まないようにする。省略された場合は
   * 何もしない(従来どおり定期リフレッシュ/ファイル監視まかせ)。
   */
  readonly refreshProjectByRootPath?: (rootPath: string) => Promise<void>;
  readonly events: EventHub;
  readonly sessions?: () => readonly AgentSession[];
  readonly links?: () => readonly SessionLink[];
  readonly commentReader?: CommentReader;
  readonly processScanner?: ProcessScanner;
  readonly humanDecisions?: HumanDecisionsPort;
  readonly worktreeScanner?: WorktreeScanner;
  /** 注入先の検証コントラクトから mainBranch を読む。失敗時は undefined。 */
  readonly getProjectMainBranch?: (rootPath: string) => Promise<string | undefined>;
  readonly issueWriter?: IssueWriterPort;
  readonly dependencyWriter?: DependencyWriterPort;
  readonly sessionLinkWriter?: SessionLinkWriterPort;
  readonly sessionTail?: SessionTailReader;
  readonly leaseReader?: LeaseReader;
  readonly mergeSlotReader?: MergeSlotReader;
  readonly prStatusReader?: PrStatusReader;
  /**
   * bdboard-ye2p: サーバー再起動をまたいで terminal な gh 結果を残すための
   * PR ステータスキャッシュ。bootstrap (wire-board-api.ts) が永続化ストアから
   * 読み込んで組み立てる。未指定なら pr-links-routes.ts が空のインメモリ
   * キャッシュにフォールバックする (テスト等)。
   */
  readonly prBadgeStatusCache?: PrBadgeStatusCache;
  readonly reclaimScheduler?: ReclaimScheduler;
  /**
   * ハーネス KPI の reclaim 指標用。サーバー起動からの累積で永続化しない
   * (bdboard-pkr6.9)。省略時は reclaim 指標が空になるだけで、他の指標は出る。
   */
  readonly reclaimHistory?: ReclaimHistory;
  /**
   * トンネル経由の書き込みを開放するための依存(bdboard-9rz)。
   * 省略された場合、書き込みは従来どおり localhost 直アクセス限定になる(fail-closed)。
   */
  readonly writeAccess?: WriteGuardDeps;
  readonly getBoardThresholds?: () => Promise<ResolvedBoardThresholds>;
  readonly getHygieneThresholds?: () => Promise<HygieneThresholds>;
}
