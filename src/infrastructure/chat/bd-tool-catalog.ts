import { z } from 'zod';
import { isSafeCliArgument, isValidBdTicketId } from '../../domain/chat.js';

export interface BdToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly writes: boolean;
}

const BD_STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;
const BD_CREATE_TYPES = ['task', 'bug', 'feature', 'epic'] as const;
type BdStatus = (typeof BD_STATUSES)[number];

const statusSchema = z.enum(BD_STATUSES);

const ticketIdSchema = z.string().refine(isValidBdTicketId, {
  message: 'invalid ticket id',
});

const freeTextSchema = z
  .string()
  .min(1, 'text must not be empty')
  .max(2000, 'text too long');

const optionalReasonSchema = z.string().max(2000, 'reason too long').optional();

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseStatusList(value: string): BdStatus[] | null {
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  const statuses: BdStatus[] = [];
  for (const part of parts) {
    const parsed = statusSchema.safeParse(part);
    if (!parsed.success) {
      return null;
    }
    statuses.push(parsed.data);
  }

  return statuses;
}

const bdListSchema = z
  .object({
    status: z.string().optional(),
    limit: z.number().optional(),
  })
  .strict();

const bdReadySchema = z
  .object({
    limit: z.number().optional(),
  })
  .strict();

const bdBlockedSchema = z.object({}).strict();

const bdShowSchema = z
  .object({
    id: ticketIdSchema,
  })
  .strict();

const bdUpdateStatusSchema = z
  .object({
    id: ticketIdSchema,
    status: statusSchema,
  })
  .strict();

const bdClaimSchema = z
  .object({
    id: ticketIdSchema,
  })
  .strict();

const bdCloseSchema = z
  .object({
    id: ticketIdSchema,
    reason: optionalReasonSchema,
  })
  .strict();

const bdCommentSchema = z
  .object({
    id: ticketIdSchema,
    text: freeTextSchema,
  })
  .strict();

const untilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid date format');

const bdDeferSchema = z
  .object({
    id: ticketIdSchema,
    untilDate: untilDateSchema,
  })
  .strict();

const bdPrioritySchema = z
  .object({
    id: ticketIdSchema,
    priority: z.number().int().min(0).max(4),
  })
  .strict();

const bdCreateTitleSchema = z
  .string()
  .min(1, 'title must not be empty')
  .max(200, 'title too long')
  .refine(isSafeCliArgument, { message: 'unsafe title' });

const bdCreateTypeSchema = z.enum(BD_CREATE_TYPES);

const bdCreateSchema = z
  .object({
    title: bdCreateTitleSchema,
    description: z.string().max(4000, 'description too long').optional(),
    type: bdCreateTypeSchema.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    parent: ticketIdSchema.optional(),
  })
  .strict();

const bdSearchQuerySchema = z
  .string()
  .min(1, 'query must not be empty')
  .max(200, 'query too long')
  .refine(isSafeCliArgument, { message: 'unsafe query' });

const bdSearchSchema = z.object({ query: bdSearchQuerySchema }).strict();

const bdDepSchema = z
  .object({
    id: ticketIdSchema,
    dependsOnId: ticketIdSchema,
  })
  .strict();

export const BD_TOOL_DEFINITIONS: readonly BdToolDefinition[] = [
  {
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
  },
  {
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
  },
  {
    name: 'bd_blocked',
    description: 'ブロック中のbdチケットを取得する',
    writes: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'bd_show',
    description: 'bdチケットの詳細を取得する',
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
] as const;

export type BdArgsBuildResult =
  | { readonly ok: true; readonly args: readonly string[]; readonly stdin?: string }
  | { readonly ok: false; readonly error: string };

function reject(error: string): BdArgsBuildResult {
  return { ok: false, error };
}

/**
 * Summarises a zod failure without echoing model-supplied keys or values back
 * into the rejection message.
 */
function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      const detail =
        issue.code === 'unrecognized_keys' ? 'unrecognized key' : issue.message;
      return path.length > 0 ? `${path}: ${detail}` : detail;
    })
    .join('; ');
}

function ok(
  args: readonly string[],
  stdin?: string,
): BdArgsBuildResult {
  return {
    ok: true,
    args,
    ...(stdin !== undefined ? { stdin } : {}),
  };
}

function buildReadonlyPrefix(projectRootPath: string): readonly string[] {
  return ['--readonly', '-C', projectRootPath];
}

function buildWritePrefix(projectRootPath: string): readonly string[] {
  return ['-C', projectRootPath];
}

export function buildBdToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): BdArgsBuildResult {
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
        `--id=${parsed.data.id}`,
      ]);
    }
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
      return reject(`unknown tool: ${toolName}`);
  }
}
