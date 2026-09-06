import { collectLeftoverCandidates } from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import { planReclaim, type ReclaimPlan } from '../../domain/reclaim-plan.js';
import type { InProgressWithLease, LeaseReader } from '../ports/lease-reader.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';

export interface PlanProjectReclaimDeps {
  /**
   * in_progress 集合と lease 失効時刻の生値の取得元 (bdboard-vz01)。盤面キャッシュ
   * (cache.getProject) は使わない — refresh-projects が失敗し続けても、この呼び出しは
   * 毎回 `bd list --status in_progress` を直接叩くので古い集合で `--id` を組まない。
   * 失敗したら (呼び出し側は) 今回の巡回を丸ごと見送ること。
   */
  readonly leaseReader: LeaseReader;
  readonly scanner: WorktreeScanner;
  readonly now?: () => Date;
  /** 判定できなかった理由のログ。未指定なら console.warn */
  readonly logWarn?: (message: string) => void;
}

/**
 * 保護打ち切りの起点を求める (bdboard-vz01)。
 *
 * 優先順位は lease_expires_at → startedAt → createdAt。lease_expires_at が使える
 * チケットは、未失効なら経過が負値になり実質無期限に保護される (heartbeat が生きて
 * いる限り lease は延長され続けるので意図した挙動)。lease 情報が無いチケットに限り、
 * 従来どおり作業開始時刻にフォールバックする。
 */
function resolveProtectionOrigin(ticket: InProgressWithLease, now: Date): Date {
  for (const raw of [ticket.leaseExpiresAt, ticket.startedAt, ticket.createdAt]) {
    if (raw === null || raw === undefined) {
      continue;
    }
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) {
      return new Date(ms);
    }
  }
  // createdAt は bd の全チケットに必ず付くので、ここに来るのは値が壊れている
  // (パース不能) 場合だけ。時刻情報が無いものとして「今始まった」扱いにする —
  // hasLiveWorktree が true なら保護され、false ならどのみち回収対象になる。
  return now;
}

/**
 * 1 プロジェクトぶんの reclaim 計画を立てる (bdboard-6aci / bdboard-vz01)。
 *
 * `null` = 判断材料が無いので今回は見送る。呼び出し側 (reclaim-scheduler) は
 * この場合 bd を一切呼ばない。**全件回収へフォールバックしない**のが要点で、
 * それをやると生存セッションのチケットを奪う元の事故に戻る。LeaseReader が
 * 失敗した場合も同様に見送る — 「盤面キャッシュが最後に成功した時点の古い集合」で
 * `--id` を組む準停止状態には戻さない。
 */
export async function planProjectReclaim(
  project: Project,
  deps: PlanProjectReclaimDeps,
): Promise<ReclaimPlan | null> {
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));

  let inProgress: readonly InProgressWithLease[];
  try {
    inProgress = await deps.leaseReader.listInProgressWithLease(project.rootPath);
  } catch (error) {
    logWarn(
      `[reclaim] could not read in-progress leases for project=${project.id}; skipping this cycle: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }

  if (inProgress.length === 0) {
    return { reclaimTicketIds: [], protectedTicketIds: [] };
  }

  let liveTicketIds: ReadonlySet<string>;
  try {
    const snapshot = await deps.scanner.scan(project.rootPath);
    if (!snapshot.complete) {
      // git が非ゼロ / timeout / spawn 失敗。スキャナはこれを空スナップショットに
      // 畳むので、`complete` を見ずに進むと全 in_progress が「worktree 無し」= 回収対象
      // になる。負荷で git が 10 秒に間に合わなかっただけで生存セッションを奪う。
      logWarn(
        `[reclaim] git worktree scan was incomplete for project=${project.id}; skipping this cycle ` +
          '(an incomplete scan cannot tell "no worktree" from "could not look")',
      );
      return null;
    }
    liveTicketIds = new Set(
      collectLeftoverCandidates(project.id, project.rootPath, snapshot).map(
        (candidate) => candidate.ticketId,
      ),
    );
  } catch (error) {
    logWarn(
      `[reclaim] could not scan git worktrees for project=${project.id}; skipping this cycle: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }

  const now = (deps.now ?? (() => new Date()))();

  return planReclaim(
    inProgress.map((ticket) => ({
      ticketId: ticket.id,
      startedAt: resolveProtectionOrigin(ticket, now),
      hasLiveWorktree: liveTicketIds.has(ticket.id),
    })),
    now,
  );
}
