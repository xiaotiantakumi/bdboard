// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、延期/優先度/ラベルの編集系
// (bd_defer / bd_priority / bd_label_add / bd_label_remove) 4ツール。カタログ定義
// (定数) と buildBdToolArgs の対応する switch case (関数本体は分割前のまま、
// buildScheduleLabelToolArgs という1関数にまとめて export しただけ) を1ファイルに
// まとめている。挙動・型は分割前と同一 (移動のみ)。
import type { BdArgsBuildResult, BdToolDefinition } from './types.js';
import { reject, ok, describeZodError, buildWritePrefix } from './args-helpers.js';
import { bdDeferSchema, bdPrioritySchema, bdLabelSchema } from './schemas.js';

export const bdDeferTool: BdToolDefinition = {
  name: 'bd_defer',
  description: 'bdチケットを指定日まで延期する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'untilDate'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      untilDate: {
        type: 'string',
        description: '延期先の日付(YYYY-MM-DD)',
      },
    },
  },
};

export const bdPriorityTool: BdToolDefinition = {
  name: 'bd_priority',
  description: 'bdチケットの優先度を更新する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'priority'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      priority: {
        type: 'number',
        description: '優先度(0=最高..4=最低)',
      },
    },
  },
};

export const bdLabelAddTool: BdToolDefinition = {
  name: 'bd_label_add',
  description: 'bdチケットにラベルを追加する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'label'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      label: {
        type: 'string',
        description: 'ラベル名',
      },
    },
  },
};

export const bdLabelRemoveTool: BdToolDefinition = {
  name: 'bd_label_remove',
  description: 'bdチケットからラベルを削除する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'label'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      label: {
        type: 'string',
        description: 'ラベル名',
      },
    },
  },
};

export function buildScheduleLabelToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult | undefined {
  switch (toolName) {
    case 'bd_defer': {
      const parsed = bdDeferSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'update',
        parsed.data.id,
        '--defer',
        parsed.data.untilDate,
      ]);
    }
    case 'bd_priority': {
      const parsed = bdPrioritySchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'update',
        parsed.data.id,
        '-p',
        String(parsed.data.priority),
      ]);
    }
    case 'bd_label_add': {
      const parsed = bdLabelSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'label',
        'add',
        parsed.data.id,
        parsed.data.label,
      ]);
    }
    case 'bd_label_remove': {
      const parsed = bdLabelSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'label',
        'remove',
        parsed.data.id,
        parsed.data.label,
      ]);
    }
    default:
      return undefined;
  }
}
