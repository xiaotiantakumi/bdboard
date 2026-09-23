import type { RepoOutputFilter } from './args-builder.js';

/**
 * bdboard-sso1.71: repo-tool-catalog.ts のモジュール分割で切り出した、git 出力の
 * 絞り込み (applyRepoOutputFilter)。バレルは ../repo-tool-catalog.ts。
 */

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
