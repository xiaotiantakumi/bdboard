// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、チケット本文の編集系
// (bd_update_title / bd_update_description / bd_append_notes / bd_comment) 4ツール。
// カタログ定義 (定数) と buildBdToolArgs の対応する switch case (関数本体は分割前の
// まま、buildContentToolArgs という1関数にまとめて export しただけ) を1ファイルに
// まとめている。挙動・型は分割前と同一 (移動のみ)。
import type { BdArgsBuildResult, BdToolDefinition } from './types.js';
import { reject, ok, describeZodError, buildWritePrefix } from './args-helpers.js';
import {
  bdUpdateTitleSchema,
  bdUpdateDescriptionSchema,
  bdAppendNotesSchema,
  bdCommentSchema,
} from './schemas.js';

export const bdUpdateTitleTool: BdToolDefinition = {
  name: 'bd_update_title',
  description: '既存bdチケットのタイトルを変更する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      title: {
        type: 'string',
        description: '新しいタイトル(1..200文字)',
      },
    },
  },
};

export const bdUpdateDescriptionTool: BdToolDefinition = {
  name: 'bd_update_description',
  description: '既存bdチケットのdescriptionを置き換える',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'description'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      description: {
        type: 'string',
        description: '新しい説明(最大4000文字、複数行可)',
      },
    },
  },
};

export const bdAppendNotesTool: BdToolDefinition = {
  name: 'bd_append_notes',
  description: '既存bdチケットのnotesに追記する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'notes'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      notes: {
        type: 'string',
        description: '追記するメモ(最大4000文字、複数行可)',
      },
    },
  },
};

export const bdCommentTool: BdToolDefinition = {
  name: 'bd_comment',
  description: 'bdチケットにコメントを追加する',
  writes: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'text'],
    properties: {
      id: {
        type: 'string',
        description: 'チケットID',
      },
      text: {
        type: 'string',
        description: 'コメント本文(1..2000文字)',
      },
    },
  },
};

export function buildContentToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult | undefined {
  switch (toolName) {
    case 'bd_update_title': {
      const parsed = bdUpdateTitleSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'update',
        parsed.data.id,
        '--title',
        parsed.data.title,
      ]);
    }
    case 'bd_update_description': {
      const parsed = bdUpdateDescriptionSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok(
        [
          ...buildWritePrefix(projectRootPath),
          'update',
          parsed.data.id,
          '--stdin',
        ],
        parsed.data.description,
      );
    }
    case 'bd_append_notes': {
      const parsed = bdAppendNotesSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok([
        ...buildWritePrefix(projectRootPath),
        'update',
        parsed.data.id,
        '--append-notes',
        parsed.data.notes,
      ]);
    }
    case 'bd_comment': {
      const parsed = bdCommentSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return reject(describeZodError(parsed.error));
      }

      return ok(
        [
          ...buildWritePrefix(projectRootPath),
          'comment',
          parsed.data.id,
          '--stdin',
        ],
        parsed.data.text,
      );
    }
    default:
      return undefined;
  }
}
