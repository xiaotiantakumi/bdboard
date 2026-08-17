import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';

export type BdErrorKind =
  | 'bd-not-found'
  | 'not-a-beads-project'
  | 'lock-contention'
  | 'schema-mismatch'
  | 'unknown';

export class BdError extends Error {
  readonly kind: BdErrorKind;
  readonly projectId: string;
  readonly detail: string;

  constructor(kind: BdErrorKind, projectId: string, detail: string) {
    super(`[${kind}] project=${projectId}: ${detail}`);
    this.name = 'BdError';
    this.kind = kind;
    this.projectId = projectId;
    this.detail = detail;
    Object.setPrototypeOf(this, BdError.prototype);
  }
}

export interface ProjectTickets {
  /** 実データから収集した接頭辞で prefixes を埋めた Project */
  readonly project: Project;
  readonly tickets: readonly Ticket[];
  /** 一部の行だけ読み飛ばした場合の部分失敗。全体は成功扱いだが UI のステータスバナーに出す */
  readonly warnings?: readonly BdError[];
}

export interface IssueRepository {
  /** 1プロジェクトのチケット全件を取得 */
  listTickets(project: Project): Promise<ProjectTickets>;

  /** 複数プロジェクトを並列度制限つきで取得。失敗したプロジェクトは errors に入れ、全体は落とさない */
  listAll(projects: readonly Project[]): Promise<{
    readonly results: readonly ProjectTickets[];
    readonly errors: readonly BdError[];
  }>;
}
