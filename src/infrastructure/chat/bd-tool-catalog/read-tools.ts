// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、読み取り系 (writes: false) の
// bd_list / bd_ready / bd_blocked / bd_show / bd_search 5ツール。カタログ定義 (定数) と
// buildBdToolArgs の対応する switch case (関数本体は分割前のまま、buildReadToolArgs という
// 1関数にまとめて export しただけ) を1ファイルにまとめている。挙動・型は分割前と同一
// (移動のみ)。
import type { BdArgsBuildResult, BdToolDefinition } from './types.js';
import { reject, ok, describeZodError, buildReadonlyPrefix } from './args-helpers.js';
import {
  bdListSchema,
  bdReadySchema,
  bdBlockedSchema,
  bdShowSchema,
  bdSearchSchema,
  clampInt,
  parseStatusList,
} from './schemas.js';

export const bdListTool: BdToolDefinition = {
  name: 'bd_list',
  description: 'bdチケット一覧を取得する',
  writes: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        description: 'カンマ区切りのステータス(open,in_progress,blocked,deferred,closed)',
      },
      limit: {
        type: 'number',
        description: '取得件数(1..200、既定50)',
      },
    },
  },
};

export const bdReadyTool: BdToolDefinition = {
  name: 'bd_ready',
  description: '着手可能なbdチケットを取得する',
  writes: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: {
        type: 'number',
        description: '取得件数(1..100、既定20)',
      },
    },
  },
};

export const bdBlockedTool: BdToolDefinition = {
  name: 'bd_blocked',
  description: 'ブロック中のbdチケットを取得する',
  writes: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
};

export const bdShowTool: BdToolDefinition = {
  name: 'bd_show',
  description: 'bdチケットの詳細とコメントを取得する',
  writes: false,
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

export const bdSearchTool: BdToolDefinition = {
  name: 'bd_search',
  description: 'キーワードでbdチケットを検索する',
  writes: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: '検索キーワード(1..200文字)',
      },
    },
  },
};

export function buildReadToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult | undefined {
  switch (toolName) {
    case 'bd_list': {
      const parsed = bdListSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      const limit = clampInt(parsed.data.limit ?? 50, 1, 200);
      const args: string[] = [
        ...buildReadonlyPrefix(projectRootPath),
        'list',
        '--json',
        '--no-pager',
        '-n',
        String(limit),
      ];

      if (parsed.data.status !== undefined) {
        const statuses = parseStatusList(parsed.data.status);
        if (statuses === null) {
          return reject('invalid status');
        }
        args.push('-s', statuses.join(','));
      }

      return ok(args);
    }
    case 'bd_ready': {
      const parsed = bdReadySchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      const limit = clampInt(parsed.data.limit ?? 20, 1, 100);
      return ok([
        ...buildReadonlyPrefix(projectRootPath),
        'ready',
        '--json',
        '-n',
        String(limit),
      ]);
    }
    case 'bd_blocked': {
      const parsed = bdBlockedSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([...buildReadonlyPrefix(projectRootPath), 'blocked', '--json']);
    }
    case 'bd_show': {
      const parsed = bdShowSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildReadonlyPrefix(projectRootPath),
        'show',
        '--json',
        '--include-comments',
        `--id=${parsed.data.id}`,
      ]);
    }
    case 'bd_search': {
      const parsed = bdSearchSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildReadonlyPrefix(projectRootPath),
        'search',
        parsed.data.query,
        '--json',
      ]);
    }
    default:
      return undefined;
  }
}
