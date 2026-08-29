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

/**
 * git の出力を呼び出し側で絞り込むための指示。どちらの絞り込みも git には
 * 渡さず、こちら側で行う。
 */
export type RepoOutputFilter =
  /** ls-tree の全パス列挙から検索語を含むものだけを残す。 */
  | { readonly kind: 'paths'; readonly needle: string; readonly maxMatches: number }
  /** git log の結果から、チケットIDが「そのIDとして」現れる行だけを残す。 */
  | { readonly kind: 'commits'; readonly ticketId: string };

export type RepoArgsBuildResult =
  | {
      readonly ok: true;
      readonly args: readonly string[];
      readonly outputFilter: RepoOutputFilter;
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
      // ただし --grep は境界の無い部分一致なので、これだけでは足りない
      // (`bdboard-x3` が `bdboard-x32` のコミットに当たる。PR#143 レビュー major-1
      // で実測)。ID として現れているかの判定は outputFilter 側で行う。
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
        outputFilter: { kind: 'commits', ticketId: parsed.data.ticketId },
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
        outputFilter: {
          kind: 'paths',
          needle: parsed.data.pattern.toLowerCase(),
          maxMatches: REPO_PATH_MAX_MATCHES,
        },
      };
    }
    default:
      return { ok: false, error: `unknown tool: ${toolName}` };
  }
}

/** bd のチケットIDに使われうる文字。ID の切れ目判定に使う。 */
const ID_CHAR_PATTERN = /[A-Za-z0-9._-]/;

/**
 * `line[index]` の文字が、隣接する ID の続きかどうか。`direction` は ID から
 * 外へ向かう向き(後ろ側なら +1、前側なら -1)。
 *
 * `.` だけ特別扱いする。`.` は ID の区切り文字でもあり(`bdboard-3tw.159.4`)、
 * 同時に文末のピリオドでもある(`Closes bdboard-x32.`)。ID の続きであれば
 * `.` の先に必ず ID 構成文字が来るので、そこまで見て判定する。
 */
function extendsId(line: string, index: number, direction: 1 | -1): boolean {
  const char = line.charAt(index);
  if (char.length === 0) {
    return false;
  }
  if (char === '.') {
    return ID_CHAR_PATTERN.test(line.charAt(index + direction));
  }
  return ID_CHAR_PATTERN.test(char);
}

/**
 * `line` の中に `id` が「そのIDとして」現れているか。前後が ID の続きなら、
 * より長い別IDの一部なので当たりとしない(`bdboard-x3` は
 * `fix(bdboard-x32): ...` に、`bdboard-3tw.159` は `bdboard-3tw.159.4` の
 * コミットに当たってはいけない)。
 */
function containsIdAtBoundary(line: string, id: string): boolean {
  for (let from = 0; ; ) {
    const index = line.indexOf(id, from);
    if (index < 0) {
      return false;
    }
    if (
      !extendsId(line, index - 1, -1) &&
      !extendsId(line, index + id.length, 1)
    ) {
      return true;
    }
    from = index + 1;
  }
}

/**
 * git の出力を行単位に割る。
 *
 * 最終行が改行で終わっていなければ、出力がどこかで切られている
 * (CommandRunner の stdout 上限。PR#143 レビュー minor-3)。git は各行を必ず
 * 改行で終えるので、これは「途中で切れた」の確実な印になる。切れかけの最終行は
 * 捨て、切られたこと自体は呼び出し元へ伝える — このツールの価値は「0件」が
 * 根拠になることなので、部分的な走査を全件走査のように見せてはいけない。
 */
function splitGitLines(stdout: string): {
  readonly lines: readonly string[];
  readonly incomplete: boolean;
} {
  if (stdout.length === 0) {
    return { lines: [], incomplete: false };
  }
  const incomplete = !stdout.endsWith('\n');
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  return {
    lines: incomplete ? lines.slice(0, -1) : lines,
    incomplete,
  };
}

/**
 * git の出力に絞り込みを当てる。「0件」がそのまま根拠になるツールなので、
 * 走査した総数・打ち切り・出力の切れも添えて返す。
 */
export function applyRepoOutputFilter(stdout: string, filter: RepoOutputFilter): string {
  const { lines, incomplete } = splitGitLines(stdout);
  const suffix = incomplete ? ' incomplete=true' : '';

  if (filter.kind === 'commits') {
    const matched = lines.filter((line) => containsIdAtBoundary(line, filter.ticketId));
    // grepped は git の部分一致が拾った数。matched との差が「別IDの巻き添え」。
    const header = `commits=${matched.length} grepped=${lines.length}${suffix}`;
    return matched.length === 0 ? header : [header, ...matched].join('\n');
  }

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
  const header = `matched=${matchCount} scanned=${lines.length}${truncated ? ` truncated=true shown=${matched.length}` : ''}${suffix}`;
  return matched.length === 0 ? header : [header, ...matched].join('\n');
}
