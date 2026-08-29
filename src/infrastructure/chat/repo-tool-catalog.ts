import { z } from 'zod';
import { isValidBdTicketId } from '../../domain/chat.js';
import type { BdToolDefinition } from './bd-tool-catalog.js';

/**
 * チャットから使える「リポジトリの事実確認」ツール(bdboard-3tw.159.4)。
 *
 * 動機: bd の status だけでは「closed だがマージされていない」「マージ済みだが
 * コードが残っている」を区別できない。2026-08-29 に bdboard-3tw.151 の顛末を
 * 確定させたのは、チケットのコメントではなく origin/main に対する2つの読み取り
 * コマンドだった。それをチャット自身にやらせるためのツール。
 *
 * 設計の芯: **allowlist 方式**。任意のシェル実行はもちろん、任意の git
 * サブコマンドも開けない。ここが組み立てられる git コマンドは `log` と
 * `ls-tree` の2つだけで、引数も個別に検証したものしか載らない。bd ツールと
 * 同じく args 配列を組み立て、シェルを経由しない。
 */

const REPO_LOG_MAX_COMMITS = 20;
const REPO_PATH_MAX_MATCHES = 200;

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * 対象 ref。既定は origin/main だが、既定ブランチが master のリポジトリでも
 * 使えるように差し替えを許す。範囲指定(`a..b`)や先頭のハイフン(オプションに
 * 化ける)は弾き、「単一の ref 名」だけを通す。
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const refSchema = z
  .string()
  .refine((value) => REF_PATTERN.test(value) && !value.includes('..'), {
    message: 'invalid ref',
  });

const ticketIdSchema = z.string().refine(isValidBdTicketId, {
  message: 'invalid ticket id',
});

/**
 * パス検索語。git には渡さず、ls-tree の出力をこちら側で絞り込むためだけに
 * 使うので、コマンドライン上の危険性は無い。制御文字と長さだけを見る。
 */
const pathPatternSchema = z
  .string()
  .min(1, 'pattern must not be empty')
  .max(200, 'pattern too long')
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), {
    message: 'unsafe pattern',
  });

const repoTicketLandedSchema = z
  .object({
    ticketId: ticketIdSchema,
    ref: refSchema.optional(),
  })
  .strict();

const repoPathExistsSchema = z
  .object({
    pattern: pathPatternSchema,
    ref: refSchema.optional(),
  })
  .strict();

export const REPO_TOOL_NAMES = ['repo_ticket_landed', 'repo_path_exists'] as const;
export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

export function isRepoToolName(toolName: string): toolName is RepoToolName {
  return (REPO_TOOL_NAMES as readonly string[]).includes(toolName);
}

export const REPO_TOOL_DEFINITIONS: readonly BdToolDefinition[] = [
  {
    name: 'repo_ticket_landed',
    description:
      'チケットIDを含むコミットが対象ref(既定 origin/main)にあるかを調べる(読み取り専用)',
    writes: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ticketId'],
      properties: {
        ticketId: {
          type: 'string',
          description: 'チケットID',
        },
        ref: {
          type: 'string',
          description: '対象ref(既定: origin/main)',
        },
      },
    },
  },
  {
    name: 'repo_path_exists',
    description:
      '対象ref(既定 origin/main)にその文字列を含むパスが残っているかを調べる(読み取り専用)',
    writes: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'パスに含まれる文字列(大文字小文字を区別しない、1..200文字)',
        },
        ref: {
          type: 'string',
          description: '対象ref(既定: origin/main)',
        },
      },
    },
  },
] as const;

/** ls-tree の全パス列挙を呼び出し側で絞り込むための指示。 */
export interface RepoPathFilter {
  /** 小文字化済みの検索語。 */
  readonly needle: string;
  readonly maxMatches: number;
}

export type RepoArgsBuildResult =
  | {
      readonly ok: true;
      readonly args: readonly string[];
      readonly pathFilter?: RepoPathFilter;
    }
  | { readonly ok: false; readonly error: string };

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

export const REPO_DEFAULT_REF = 'origin/main';

function buildPrefix(projectRootPath: string): readonly string[] {
  return ['-C', projectRootPath, '--no-pager'];
}

export function buildRepoToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): RepoArgsBuildResult {
  switch (toolName) {
    case 'repo_ticket_landed': {
      const parsed = repoTicketLandedSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { ok: false, error: describeZodError(parsed.error) };
      }

      // --fixed-strings を必ず付ける。チケットIDには `.` が含まれ(bdboard-3tw.151)、
      // 既定の正規表現マッチだと `bdboard-3tw151` のような別IDまで拾ってしまう。
      // 末尾の `--` は ref とパスの取り違えを防ぐため。
      return {
        ok: true,
        args: [
          ...buildPrefix(projectRootPath),
          'log',
          `--max-count=${REPO_LOG_MAX_COMMITS}`,
          '--fixed-strings',
          `--grep=${parsed.data.ticketId}`,
          '--date=short',
          '--format=%h %ad %s',
          parsed.data.ref ?? REPO_DEFAULT_REF,
          '--',
        ],
      };
    }
    case 'repo_path_exists': {
      const parsed = repoPathExistsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { ok: false, error: describeZodError(parsed.error) };
      }

      return {
        ok: true,
        args: [
          ...buildPrefix(projectRootPath),
          'ls-tree',
          '-r',
          '--name-only',
          parsed.data.ref ?? REPO_DEFAULT_REF,
          '--',
        ],
        pathFilter: {
          needle: parsed.data.pattern.toLowerCase(),
          maxMatches: REPO_PATH_MAX_MATCHES,
        },
      };
    }
    default:
      return { ok: false, error: `unknown tool: ${toolName}` };
  }
}

/**
 * ls-tree の出力を検索語で絞り込む。「0件」がそのまま「本当に無い」の根拠に
 * なるツールなので、走査した総数と打ち切りの有無も添えて返す(0件が
 * 「絞り込む前から空だった」のか「全件見た上で無かった」のか区別できるように)。
 */
export function filterRepoPaths(stdout: string, filter: RepoPathFilter): string {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const matched: string[] = [];
  let matchCount = 0;

  for (const line of lines) {
    if (!line.toLowerCase().includes(filter.needle)) {
      continue;
    }
    matchCount += 1;
    if (matched.length < filter.maxMatches) {
      matched.push(line);
    }
  }

  const truncated = matchCount > matched.length;
  const header = `matched=${matchCount} scanned=${lines.length}${truncated ? ` truncated=true shown=${matched.length}` : ''}`;
  return matched.length === 0 ? header : [header, ...matched].join('\n');
}
