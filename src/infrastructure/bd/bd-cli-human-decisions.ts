// src/infrastructure/bd/bd-cli-human-decisions.ts は bdboard-sso1.16 でモジュール分割された。
// 実体は ./bd-cli-human-decisions/ 配下:
//   - read.ts / read-parse.ts   : pending decisions の読み取りと bd stdout パース
//   - respond.ts / respond-comment.ts / respond-args.ts : gate 回答の解決と書き込み
//   - labels.ts                 : human ラベルの掃除
//   - shared.ts                 : kind (gate/ticket) 判定と bd CLI コマンド実行の共通基盤
// (200 行の上限に収めるため、read と respond はそれぞれもう1段細分化している)。このファイルは
// import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。挙動・型は一切
// 変えていない (移動のみ)。
//
// createBdCliHumanDecisions() 自体は元々クラスではなく、commandRunner/bdPath/timeoutMs を
// クロージャで捕捉するオブジェクトファクトリだった。分割にあたり、公開 API (関数名・引数・
// 戻り値の形) とコンストラクタ引数 (commandRunner, options) は変えず、各メソッドの本体だけを
// 対応するモジュールの関数へ委譲する形にした (クロージャ捕捉していた変数は明示引数に変換)。
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  HumanDecisionsPort,
  PendingDecision,
  PendingDecisionOption,
  RespondOutcome,
} from '../../application/ports/human-decisions.js';
import { listPendingDecisions } from './bd-cli-human-decisions/read.js';
import { respond } from './bd-cli-human-decisions/respond.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export type { HumanDecisionsPort, PendingDecision, PendingDecisionOption, RespondOutcome };

export interface BdCliHumanDecisionsOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

export function createBdCliHumanDecisions(
  commandRunner: CommandRunner,
  options?: BdCliHumanDecisionsOptions,
): HumanDecisionsPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listPendingDecisions(rootPath: string): Promise<readonly PendingDecision[]> {
      return listPendingDecisions(commandRunner, bdPath, timeoutMs, rootPath);
    },

    async respond(
      rootPath: string,
      issueId: string,
      responseText: string,
    ): Promise<RespondOutcome> {
      return respond(commandRunner, bdPath, timeoutMs, rootPath, issueId, responseText);
    },
  };
}

// 以下は分割前の公開エクスポート面 (値) をそのまま再エクスポートする。新しく増やさない
// (bd-cli-human-decisions.exportSurface.test.ts が Object.keys() で集合の一致を固定する)。
export { bdGateListItemSchema } from './bd-cli-human-decisions/read-parse.js';
export { buildGateCloseReason } from './bd-cli-human-decisions/respond-args.js';
export {
  buildResponseCommentBody,
  buildTicketAmbiguousGatesResponseCommentBody,
  buildTicketResponseCommentBody,
  buildUnknownKindResponseCommentBody,
} from './bd-cli-human-decisions/respond-comment.js';
export {
  parseShowWithDependentsStdout,
  resolveGateBlockedTicketIds,
} from './bd-cli-human-decisions/labels.js';
export {
  parseShowStdoutForKind,
  resolveKind,
  resolveKindAndBlockingGates,
} from './bd-cli-human-decisions/shared.js';
