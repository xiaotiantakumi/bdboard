import {
  buildHarnessContractTicketContent,
  HARNESS_CONTRACT_TICKET_LABEL,
  HARNESS_CONTRACT_TICKET_PRIORITY,
  HARNESS_CONTRACT_TICKET_TYPE,
} from '../../domain/harness-contract-ticket.js';
import type { ContractState, VerifyPackageScripts } from '../../domain/harness-contract.js';

/**
 * `fileHarnessContractTicket` が要求する IssueWriterPort の部分集合。
 *
 * IssueWriterPort.create / findOpenTicketByLabel は optional (bdboard-p5l.25) なので、
 * ルーティング層で存在チェックした後この narrower な型へ渡す — この関数の内部では
 * undefined チェックを繰り返さずに済む。
 */
export interface HarnessContractTicketWriter {
  findOpenTicketByLabel(
    rootPath: string,
    label: string,
  ): Promise<{ readonly id: string; readonly title: string } | null>;
  create(
    rootPath: string,
    input: {
      readonly title: string;
      readonly description: string;
      readonly type: string;
      readonly priority: number;
      readonly labels: readonly string[];
    },
  ): Promise<{ readonly id: string }>;
}

export type FileHarnessContractTicketResult =
  | { readonly ok: true; readonly ticketId: string; readonly created: boolean }
  /** 検証コントラクトが `ok` / `not-applicable` — そもそも直すことが無い。 */
  | { readonly ok: false; readonly reason: 'not-applicable' };

/**
 * 検証コントラクト不足を直すチケットを、そのプロジェクト自身の bd に起票する
 * (bdboard-p5l.25)。
 *
 * 冪等性: `HARNESS_CONTRACT_TICKET_LABEL` の付いた未クローズチケットが既にあれば
 * 作らず、その ID を `created: false` で返す。bd 側 (`bd list --label`) が持つ
 * 「既定で closed を除外する」挙動をそのまま存在確認に使う。
 */
export async function fileHarnessContractTicket(
  issueWriter: HarnessContractTicketWriter,
  rootPath: string,
  contract: ContractState,
  rootPackageScripts: VerifyPackageScripts,
): Promise<FileHarnessContractTicketResult> {
  const content = buildHarnessContractTicketContent(contract, rootPackageScripts);
  if (content === null) {
    return { ok: false, reason: 'not-applicable' };
  }

  const existing = await issueWriter.findOpenTicketByLabel(
    rootPath,
    HARNESS_CONTRACT_TICKET_LABEL,
  );
  if (existing !== null) {
    return { ok: true, ticketId: existing.id, created: false };
  }

  const created = await issueWriter.create(rootPath, {
    title: content.title,
    description: content.description,
    type: HARNESS_CONTRACT_TICKET_TYPE,
    priority: HARNESS_CONTRACT_TICKET_PRIORITY,
    labels: [HARNESS_CONTRACT_TICKET_LABEL],
  });

  return { ok: true, ticketId: created.id, created: true };
}
