// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、新規作成/依存関係系
// (bd_create / bd_dep_add / bd_dep_remove) 3ツール。カタログ定義 (定数) と
// buildBdToolArgs の対応する switch case (関数本体は分割前のまま、
// buildCreateDepToolArgs という1関数にまとめて export しただけ) を1ファイルに
// まとめている。挙動・型は分割前と同一 (移動のみ)。
import type { BdArgsBuildResult, BdToolDefinition } from './types.js';
import { reject, ok, describeZodError, buildWritePrefix } from './args-helpers.js';
import { BD_CREATE_TYPES, bdCreateSchema, bdDepSchema } from './schemas.js';

export const bdCreateTool: BdToolDefinition = {
  name: 'bd_create',
  description: '新しいbdチケットを作成する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: {
        type: 'string',
        description: 'チケットタイトル(1..200文字)',
      },
      description: {
        type: 'string',
        description: 'チケット説明(最大4000文字、複数行可)',
      },
      type: {
        type: 'string',
        enum: [...BD_CREATE_TYPES],
        description: 'チケット種別(既定: task)',
      },
      priority: {
        type: 'number',
        description: '優先度(0=最高..4=最低、既定: 2)',
      },
      parent: {
        type: 'string',
        description: '親チケットID(階層子チケットの場合)',
      },
    },
  },
};

export const bdDepAddTool: BdToolDefinition = {
  name: 'bd_dep_add',
  description: 'bdチケット間にblocks依存を追加する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'dependsOnId'],
    properties: {
      id: {
        type: 'string',
        description: '依存する側のチケットID',
      },
      dependsOnId: {
        type: 'string',
        description: '依存先(ブロックする側)のチケットID',
      },
    },
  },
};

export const bdDepRemoveTool: BdToolDefinition = {
  name: 'bd_dep_remove',
  description: 'bdチケット間のblocks依存を削除する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'dependsOnId'],
    properties: {
      id: {
        type: 'string',
        description: '依存する側のチケットID',
      },
      dependsOnId: {
        type: 'string',
        description: '依存先(ブロックする側)のチケットID',
      },
    },
  },
};

export function buildCreateDepToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult | undefined {
  switch (toolName) {
    case 'bd_create': {
      const parsed = bdCreateSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      const type = parsed.data.type ?? 'task';
      const priority = parsed.data.priority ?? 2;

      const args: string[] = [
        ...buildWritePrefix(projectRootPath),
        'create',
        '--title',
        parsed.data.title,
        '--type',
        type,
        '--priority',
        String(priority),
      ];

      if (parsed.data.parent !== undefined) {
        args.push('--parent', parsed.data.parent);
      }

      if (parsed.data.description !== undefined && parsed.data.description.length > 0) {
        args.push('--stdin');
        return ok(args, parsed.data.description);
      }

      return ok(args);
    }
    case 'bd_dep_add': {
      const parsed = bdDepSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'dep',
        'add',
        parsed.data.id,
        parsed.data.dependsOnId,
      ]);
    }
    case 'bd_dep_remove': {
      const parsed = bdDepSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'dep',
        'remove',
        parsed.data.id,
        parsed.data.dependsOnId,
      ]);
    }
    default:
      return undefined;
  }
}
