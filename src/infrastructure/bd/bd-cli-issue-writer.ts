// src/infrastructure/bd/bd-cli-issue-writer.ts は bdboard-sso1.24 でモジュール分割された。
// 実体は ./bd-cli-issue-writer/ 配下:
//   - shared.ts               : CAS 読み取りの共通ジェネリック (readTicketField)
//   - read-status-priority.ts : priority/status の CAS 読み取り (readCurrentPriority/Status)
//   - read-content.ts         : title/description の CAS 読み取り (readCurrentTitle/Description)
//   - find-by-label.ts        : findOpenTicketByLabel の CAS 不要読み取り
//   - lifecycle.ts            : claim/close/unclaim/reopen/undefer
//   - schedule-label.ts       : defer/setPriority/addLabel/removeLabel/undoPriority
//   - content.ts              : addComment/updateTitle/updateDescription
//   - create-dep.ts           : create/findOpenTicketByLabel/setMetadata
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
//
// createBdCliIssueWriter() 自体は元々クラスではなく、commandRunner/bdPath/timeoutMs を
// クロージャで捕捉するオブジェクトファクトリだった。分割にあたり、公開 API (関数名・引数・
// 戻り値の形) とコンストラクタ引数 (commandRunner, options) は変えず、各メソッドの本体だけを
// 対応するモジュールの関数へ委譲する形にした (クロージャ捕捉していた変数は明示引数に変換)。
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import {
  addLabel,
  defer,
  removeLabel,
  setPriority,
  undoPriority,
} from './bd-cli-issue-writer/schedule-label.js';
import { addComment, updateDescription, updateTitle } from './bd-cli-issue-writer/content.js';
import { create, findOpenTicketByLabel, setMetadata } from './bd-cli-issue-writer/create-dep.js';
import { claim, close, reopen, unclaim, undefer } from './bd-cli-issue-writer/lifecycle.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliIssueWriterOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

export function createBdCliIssueWriter(
  commandRunner: CommandRunner,
  options?: BdCliIssueWriterOptions,
): IssueWriterPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async claim(rootPath: string, ticketId: string): Promise<void> {
      await claim(commandRunner, bdPath, timeoutMs, rootPath, ticketId);
    },

    async close(rootPath: string, ticketId: string, reason?: string): Promise<void> {
      await close(commandRunner, bdPath, timeoutMs, rootPath, ticketId, reason);
    },

    async defer(rootPath: string, ticketId: string, untilDate: string): Promise<void> {
      await defer(commandRunner, bdPath, timeoutMs, rootPath, ticketId, untilDate);
    },

    async setPriority(rootPath: string, ticketId: string, priority: number): Promise<void> {
      await setPriority(commandRunner, bdPath, timeoutMs, rootPath, ticketId, priority);
    },

    async addComment(rootPath: string, ticketId: string, text: string): Promise<void> {
      await addComment(commandRunner, bdPath, timeoutMs, rootPath, ticketId, text);
    },

    async addLabel(rootPath: string, ticketId: string, label: string): Promise<void> {
      await addLabel(commandRunner, bdPath, timeoutMs, rootPath, ticketId, label);
    },

    async removeLabel(rootPath: string, ticketId: string, label: string): Promise<void> {
      await removeLabel(commandRunner, bdPath, timeoutMs, rootPath, ticketId, label);
    },

    async reopen(rootPath: string, ticketId: string): Promise<void> {
      await reopen(commandRunner, bdPath, timeoutMs, rootPath, ticketId);
    },

    async unclaim(rootPath: string, ticketId: string): Promise<void> {
      await unclaim(commandRunner, bdPath, timeoutMs, rootPath, ticketId);
    },

    async undefer(rootPath: string, ticketId: string): Promise<void> {
      await undefer(commandRunner, bdPath, timeoutMs, rootPath, ticketId);
    },

    async undoPriority(
      rootPath: string,
      ticketId: string,
      expectedCurrentPriority: number,
      previousPriority: number,
    ): Promise<void> {
      await undoPriority(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
        expectedCurrentPriority,
        previousPriority,
      );
    },

    async updateTitle(
      rootPath: string,
      ticketId: string,
      title: string,
      expectedCurrentTitle: string,
    ): Promise<void> {
      await updateTitle(commandRunner, bdPath, timeoutMs, rootPath, ticketId, title, expectedCurrentTitle);
    },

    async updateDescription(
      rootPath: string,
      ticketId: string,
      description: string,
      expectedCurrentDescription: string,
    ): Promise<void> {
      await updateDescription(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
        description,
        expectedCurrentDescription,
      );
    },

    async findOpenTicketByLabel(
      rootPath: string,
      label: string,
    ): Promise<
      | {
          readonly id: string;
          readonly title: string;
          readonly metadata: Readonly<Record<string, unknown>>;
        }
      | null
    > {
      return findOpenTicketByLabel(commandRunner, bdPath, timeoutMs, rootPath, label);
    },

    async create(
      rootPath: string,
      input: {
        readonly title: string;
        readonly description: string;
        readonly type: string;
        readonly priority: number;
        readonly labels: readonly string[];
        readonly metadata?: Readonly<Record<string, string>>;
      },
    ): Promise<{ readonly id: string }> {
      return create(commandRunner, bdPath, timeoutMs, rootPath, input);
    },

    async setMetadata(rootPath: string, ticketId: string, key: string, value: string): Promise<void> {
      await setMetadata(commandRunner, bdPath, timeoutMs, rootPath, ticketId, key, value);
    },
  };
}
