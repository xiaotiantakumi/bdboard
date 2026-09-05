import { collectLeftoverCandidates } from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import { planReclaim, type ReclaimPlan } from '../../domain/reclaim-plan.js';
import type { Ticket } from '../../domain/ticket.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';

export interface PlanProjectReclaimDeps {
  /**
   * そのプロジェクトのチケット。盤面キャッシュがまだ持っていない (起動直後・取得失敗)
   * なら **undefined を返すこと**。空配列で代用すると「in_progress は 1 件も無い」と
   * 解釈され、回収が黙って止まる。
   */
  readonly listTickets: (project: Project) => readonly Ticket[] | undefined;
  readonly scanner: WorktreeScanner;
  readonly now?: () => Date;
  /** 判定できなかった理由のログ。未指定なら console.warn */
  readonly logWarn?: (message: string) => void;
}

/**
 * 1 プロジェクトぶんの reclaim 計画を立てる (bdboard-6aci)。
 *
 * `null` = 判断材料が無いので今回は見送る。呼び出し側 (reclaim-scheduler) は
 * この場合 bd を一切呼ばない。**全件回収へフォールバックしない**のが要点で、
 * それをやると生存セッションのチケットを奪う元の事故に戻る。
 */
export async function planProjectReclaim(
  project: Project,
  deps: PlanProjectReclaimDeps,
): Promise<ReclaimPlan | null> {
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));

  const tickets = deps.listTickets(project);
  if (tickets === undefined) {
    logWarn(
      `[reclaim] no cached tickets for project=${project.id}; skipping this cycle ` +
        '(reclaim needs the in-flight ticket list to protect live worktrees)',
    );
    return null;
  }

  const inProgress = tickets.filter((ticket) => ticket.status === 'in_progress');
  if (inProgress.length === 0) {
    return { reclaimTicketIds: [], protectedTicketIds: [] };
  }

  let liveTicketIds: ReadonlySet<string>;
  try {
    const snapshot = await deps.scanner.scan(project.rootPath);
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
      // startedAt が無いチケットは updatedAt で代用する。どちらも claim 以降にしか
      // 進まないので、保護が実際より早く切れる方向にしか外れない (安全側)。
      startedAt: ticket.startedAt ?? ticket.updatedAt,
      hasLiveWorktree: liveTicketIds.has(ticket.id),
    })),
    now,
  );
}
