// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、チケットの状態遷移系
// (bd_update_status / bd_claim / bd_close) 3ツール。カタログ定義 (定数) と
// buildBdToolArgs の対応する switch case (関数本体は分割前のまま、
// buildLifecycleToolArgs という1関数にまとめて export しただけ) を1ファイルに
// まとめている。挙動・型は分割前と同一 (移動のみ)。
import { isSafeCliArgument } from '../../../domain/chat.js';
import type { BdArgsBuildResult, BdToolDefinition } from './types.js';
import { reject, ok, describeZodError, buildWritePrefix } from './args-helpers.js';
import { BD_STATUSES, bdUpdateStatusSchema, bdClaimSchema, bdCloseSchema } from './schemas.js';

export const bdUpdateStatusTool: BdToolDefinition = {
  name: 'bd_update_status',
  description: 'bdチケットのステータスを更新する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      status: {
        type: 'string',
        enum: [...BD_STATUSES],
      },
    },
  },
};

export const bdClaimTool: BdToolDefinition = {
  name: 'bd_claim',
  description: 'bdチケットを着手(claim)する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
    },
  },
};

export const bdCloseTool: BdToolDefinition = {
  name: 'bd_close',
  description: 'bdチケットをクローズする',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      reason: {
        type: 'string',
        description: 'クローズ理由(最大2000文字)',
      },
    },
  },
};

export function buildLifecycleToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult | undefined {
  switch (toolName) {
    case 'bd_update_status': {
      const parsed = bdUpdateStatusSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'update',
        parsed.data.id,
        '-s',
        parsed.data.status,
      ]);
    }
    case 'bd_claim': {
      const parsed = bdClaimSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'update',
        parsed.data.id,
        '--claim',
      ]);
    }
    case 'bd_close': {
      const parsed = bdCloseSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      const args: string[] = [
        ...buildWritePrefix(projectRootPath),
        'close',
        parsed.data.id,
      ];

      if (parsed.data.reason !== undefined) {
        if (!isSafeCliArgument(parsed.data.reason)) {
          return reject('unsafe reason');
        }
        args.push('-r', parsed.data.reason);
      }

      return ok(args);
    }
    default:
      return undefined;
  }
}
