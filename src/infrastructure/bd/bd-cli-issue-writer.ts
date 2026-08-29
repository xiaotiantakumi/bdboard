import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  ContentConflictError,
  PriorityConflictError,
  StatusConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import {
  runBdCommand,
  runBdCommandForStdout,
  runBdTool,
} from './bd-cli-tool-runner.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

// undoPriority の CAS チェック用。bd show --json の出力から priority だけ読めればよい。
const bdShowPriorityItemSchema = z.object({
  id: z.string(),
  priority: z.number().int().min(0).max(4),
});

async function readCurrentPriority(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<number> {
  const stdout = await runBdCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['--readonly', '-C', rootPath, 'show', '--json', `--id=${ticketId}`],
    ticketId,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError(
      'unknown',
      ticketId,
      'failed to parse bd show output while checking priority for undo',
    );
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = bdShowPriorityItemSchema.safeParse(item);
  if (!result.success) {
    throw new BdError(
      'unknown',
      ticketId,
      'bd show output missing priority while checking undo precondition',
    );
  }

  return result.data.priority;
}

// reopen/undefer の CAS チェック用。bd show --json の出力から status だけ読めればよい。
// bdboard-3tw.93: bd reopen / bd undefer は前提条件を満たさなくても exit 0 の
// まま no-op するため、実コマンドを叩く前にここで現在ステータスを確認する。
const bdShowStatusItemSchema = z.object({
  id: z.string(),
  status: z.string(),
});

async function readCurrentStatus(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<string> {
  const stdout = await runBdCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['--readonly', '-C', rootPath, 'show', '--json', `--id=${ticketId}`],
    ticketId,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError(
      'unknown',
      ticketId,
      'failed to parse bd show output while checking status for undo',
    );
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = bdShowStatusItemSchema.safeParse(item);
  if (!result.success) {
    throw new BdError(
      'unknown',
      ticketId,
      'bd show output missing status while checking undo precondition',
    );
  }

  return result.data.status;
}

// updateTitle/updateDescription の CAS チェック用。bd show --json の出力から
// title / description だけ読めればよい。
const bdShowTitleItemSchema = z.object({
  id: z.string(),
  title: z.string(),
});

const bdShowDescriptionItemSchema = z.object({
  id: z.string(),
  description: z.string().nullish(),
});

async function readCurrentTitle(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<string> {
  const stdout = await runBdCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['--readonly', '-C', rootPath, 'show', '--json', `--id=${ticketId}`],
    ticketId,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError(
      'unknown',
      ticketId,
      'failed to parse bd show output while checking title for update',
    );
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = bdShowTitleItemSchema.safeParse(item);
  if (!result.success) {
    throw new BdError(
      'unknown',
      ticketId,
      'bd show output missing title while checking update precondition',
    );
  }

  return result.data.title;
}

async function readCurrentDescription(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<string> {
  const stdout = await runBdCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['--readonly', '-C', rootPath, 'show', '--json', `--id=${ticketId}`],
    ticketId,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError(
      'unknown',
      ticketId,
      'failed to parse bd show output while checking description for update',
    );
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = bdShowDescriptionItemSchema.safeParse(item);
  if (!result.success) {
    throw new BdError(
      'unknown',
      ticketId,
      'bd show output missing description while checking update precondition',
    );
  }

  return result.data.description ?? '';
}

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
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_claim',
        { id: ticketId },
        ticketId,
      );
    },

    async close(
      rootPath: string,
      ticketId: string,
      reason?: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_close',
        {
          id: ticketId,
          ...(reason !== undefined ? { reason } : {}),
        },
        ticketId,
      );
    },

    async defer(
      rootPath: string,
      ticketId: string,
      untilDate: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_defer',
        { id: ticketId, untilDate },
        ticketId,
      );
    },

    async setPriority(
      rootPath: string,
      ticketId: string,
      priority: number,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_priority',
        { id: ticketId, priority },
        ticketId,
      );
    },

    async addComment(
      rootPath: string,
      ticketId: string,
      text: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_comment',
        { id: ticketId, text },
        ticketId,
      );
    },

    // bd-tool-catalog 経由でチャットエージェントと同じ bd label add/remove を叩く。
    async addLabel(
      rootPath: string,
      ticketId: string,
      label: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_label_add',
        { id: ticketId, label },
        ticketId,
      );
    },

    async removeLabel(
      rootPath: string,
      ticketId: string,
      label: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_label_remove',
        { id: ticketId, label },
        ticketId,
      );
    },

    // 以下 3 メソッドはクイックアクションの逆操作(undo)専用。bd-tool-catalog(チャット
    // エージェントに公開するツール一覧)を経由せず bd を直接呼ぶ。理由は
    // bd-cli-tool-runner.ts の runBdCommand の doc コメントを参照。
    // bdboard-3tw.93: `bd reopen` is exit-0-and-no-op when the ticket isn't
    // currently closed (it prints something like 'is not closed; nothing to
    // do' to stderr but does not fail) — the old implementation trusted the
    // exit code and reported a fake success to the UI. Read-then-write CAS,
    // same shape as undoPriority (bdboard-3tw.82): check the current status
    // first and refuse to write if it has drifted away from 'closed'.
    async reopen(rootPath: string, ticketId: string): Promise<void> {
      const actualStatus = await readCurrentStatus(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
      );

      if (actualStatus !== 'closed') {
        throw new StatusConflictError(ticketId, 'closed', actualStatus);
      }

      await runBdCommand(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ['-C', rootPath, 'reopen', ticketId],
        ticketId,
      );
    },

    async unclaim(rootPath: string, ticketId: string): Promise<void> {
      await runBdCommand(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ['-C', rootPath, 'unclaim', ticketId],
        ticketId,
      );
    },

    async undefer(rootPath: string, ticketId: string): Promise<void> {
      // bdboard-3tw.82: 以前は `update --defer ''` という素朴なフィールド更新だったが、
      // これはステータスの前提条件を明示的にチェックしない未文書化の副作用に頼っていた。
      // 専用の `bd undefer` サブコマンドへ切り替えた。
      //
      // bdboard-3tw.93: ただし `bd undefer` のガードは exit 0 のまま no-op するだけで
      // エラーにはならない(「reopen/unclaim と同じ形の built-in ガード」という以前の
      // コメントは、無言で上書きしないという意味では正しかったが、エラーを返すという
      // 意味では誤りだった)。undoPriority(bdboard-3tw.82)と同じ read-then-write CAS で
      // 対処する: 呼び出し前に現在ステータスを確認し、'deferred' から動いていれば
      // 書き込まずに StatusConflictError を投げる。
      const actualStatus = await readCurrentStatus(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
      );

      if (actualStatus !== 'deferred') {
        throw new StatusConflictError(ticketId, 'deferred', actualStatus);
      }

      await runBdCommand(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ['-C', rootPath, 'undefer', ticketId],
        ticketId,
      );
    },

    // bdboard-3tw.82: bd に --if-priority が無いため、read-then-write で CAS を近似する。
    // 現在値を bd show で読み、Undo が想定している「クイックアクション実行直後の値」と
    // 一致するときだけ setPriority を叩く。不一致なら書き込まず PriorityConflictError。
    async undoPriority(
      rootPath: string,
      ticketId: string,
      expectedCurrentPriority: number,
      previousPriority: number,
    ): Promise<void> {
      const actualPriority = await readCurrentPriority(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
      );

      if (actualPriority !== expectedCurrentPriority) {
        throw new PriorityConflictError(
          ticketId,
          expectedCurrentPriority,
          actualPriority,
        );
      }

      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_priority',
        { id: ticketId, priority: previousPriority },
        ticketId,
      );
    },

    async updateTitle(
      rootPath: string,
      ticketId: string,
      title: string,
      expectedCurrentTitle: string,
    ): Promise<void> {
      const actualTitle = await readCurrentTitle(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
      );

      if (actualTitle !== expectedCurrentTitle) {
        throw new ContentConflictError(
          ticketId,
          'title',
          expectedCurrentTitle,
          actualTitle,
        );
      }

      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_update_title',
        { id: ticketId, title },
        ticketId,
      );
    },

    async updateDescription(
      rootPath: string,
      ticketId: string,
      description: string,
      expectedCurrentDescription: string,
    ): Promise<void> {
      const actualDescription = await readCurrentDescription(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        ticketId,
      );

      if (actualDescription !== expectedCurrentDescription) {
        throw new ContentConflictError(
          ticketId,
          'description',
          expectedCurrentDescription,
          actualDescription,
        );
      }

      if (description.length === 0) {
        // bd-tool-catalog の bd_update_description は min(1) だが、REST API は
        // description クリア(空文字)を許容する。--stdin に空文字を渡すと
        // --allow-empty-description が必要になるため、インライン --description "" を使う。
        await runBdCommand(
          commandRunner,
          bdPath,
          timeoutMs,
          rootPath,
          ['-C', rootPath, 'update', ticketId, '--description', ''],
          ticketId,
        );
        return;
      }

      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_update_description',
        { id: ticketId, description },
        ticketId,
      );
    },
  };
}
