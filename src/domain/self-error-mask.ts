/**
 * bdboard 本体のエラー文から、ローカルだけの名前を伏せる (bdboard-4y8q.6.2、docs/ISSUE-REPORTING.md「本体エラーの間引き」)。
 *
 * 公開本文を組む 4y8q.2 の置き換え (issue-public-*.ts) とは別物で、ここは「同じエラーを別のプロジェクトで見ても同じ文字列になる」ための
 * 軽い正規化と、下書きに入れる前の最初の網。置き換えの種類は 3 つ (重なったときは上から勝つ):
 *   1. プロジェクトの根と別名のパス → <project-root>
 *   2. 接頭辞で始まるチケット ID → <ticket-id>
 *   3. プロジェクトの名前と接頭辞そのもの (3 文字以上、語の境界で一致) → <project>。どちらも Dolt のデータベース名の形
 *      (`-` と `.` を `_` に替えたもの) も探す。bd のデータベース名の既定は接頭辞で (`bd init --database` の説明
 *      「default: issue prefix」)、#432 の文 `database "<名前>" not found on dolt server` に出るのはこの名前
 *      (接頭辞 `epic-haslett-00ae14` → `epic_haslett_00ae14`、接頭辞 `personal` とフォルダ名 `personal-todo`)。
 *
 * 置き換えは元の文字列の上で一致の範囲をまとめて集め、重ならないものだけを左から 1 回で印に替える。印を入れた後の文字列は探し直さない
 * (名前が `project` のとき、入れたばかりの `<project-root>` の中に一致して印が壊れるため)。
 */
import { nounVariants } from './issue-public-key-variants.js';
import type { Project } from './project.js';
import { isProjectPrefix } from './project.js';

export type SelfErrorMaskProject = Pick<Project, 'name' | 'rootPath' | 'aliasPaths' | 'prefixes'>;

/** これ未満 (コードポイント数) の名前は、一般語を壊すので置き換えない。 */
export const SELF_ERROR_MIN_NAME_LENGTH = 3;
export const SELF_ERROR_PROJECT_ROOT_MARK = '<project-root>';
export const SELF_ERROR_PROJECT_MARK = '<project>';
export const SELF_ERROR_TICKET_ID_MARK = '<ticket-id>';

interface Candidate {
  readonly regex: RegExp;
  readonly mark: string;
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly mark: string;
}

/** `u` フラグでは `\-` が書けないので `-` はエスケープしない (文字クラスの外では特別な意味が無い)。 */
function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * 大小文字を無視して重複を 1 つにまとめ、公開本文の置き換え (issue-public-key-variants.ts) と同じ変種を足す: NFC と NFD (macOS のファイル名は
 * 分解形のことがある) と、それぞれの URL のパーセント表記 (`file:///work/my%20proj`)。長い順に返す。
 */
function withUnicodeVariants(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    for (const form of nounVariants(value)) {
      const folded = form.toLowerCase();
      if (!unique.has(folded)) unique.set(folded, form);
    }
  }
  return [...unique.values()].sort((a, b) => b.length - a.length);
}

/** 末尾の区切りを手で落とす (`[\\/]+$` の正規表現は、区切りが長く続く入力で 2 乗になりうる)。 */
function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;
  return path.slice(0, end);
}

/** そのまま・`/` 区切り・`\` 区切り・JSON に埋め込まれた `\\` 区切り。 */
function separatorForms(path: string): string[] {
  const backslash = path.replaceAll('/', '\\');
  return [path, path.replaceAll('\\', '/'), backslash, backslash.replaceAll('\\', '\\\\')];
}

/** パスの前後は、別のフォルダ名の一部かどうかを見るので Unicode の文字・数字まで含める。 */
const PATH_WORD = String.raw`\p{L}\p{N}`;
/** 名前・チケット ID の前後は ASCII の英数字だけ。空白で区切らない文 (日本語など) の中の名前も伏せ、漏らさない側に倒す (`\b` もここでは働かない)。 */
const ASCII_WORD = 'A-Za-z0-9';

function candidatesOf(literals: readonly string[], build: (escaped: string) => string, mark: string): Candidate[] {
  return literals.map((literal) => ({ regex: new RegExp(build(escapeRegex(literal)), 'giu'), mark }));
}

/** Dolt のデータベース名に使えない `-` と `.` を `_` にした形 (bd が接頭辞からデータベース名を作るときの書き換え)。 */
function doltDatabaseForm(value: string): string {
  return value.replace(/[-.]/g, '_');
}

function buildGroups(projects: readonly SelfErrorMaskProject[]): Candidate[][] {
  const paths = projects
    .flatMap((project) => [project.rootPath, ...project.aliasPaths])
    .map(trimTrailingSeparators)
    .filter((path) => path.length > 0)
    .flatMap(separatorForms);
  const prefixes = projects.flatMap((project) => project.prefixes).filter(isProjectPrefix);
  // 接頭辞そのもの (ID の形でない `personal`) も名前と同じ規則で伏せる。2 文字の `bd` はコマンド名と区別できないので残る。
  const names = [...projects.map((project) => project.name.trim()), ...prefixes]
    .flatMap((value) => [value, doltDatabaseForm(value)])
    .filter((name) => [...name].length >= SELF_ERROR_MIN_NAME_LENGTH);
  return [
    // 直後が語・`_`・`-` なら別のパス (`/work/app` に対する `/work/app2`)。直前は見ない (公開本文の置き換えと同じ): `-C/work/app` のような
    // 区切りの無いフラグや、実体パスの前置き (`/System/Volumes/Data/work/app`) の中でも伏せる。`/srv/work/app` も `/srv<project-root>` になる (伏せすぎる側)。
    candidatesOf(
      withUnicodeVariants(paths),
      (escaped) => `${escaped}(?![${PATH_WORD}_-])`,
      SELF_ERROR_PROJECT_ROOT_MARK,
    ),
    // 短い ID は `4y8q`・`3tw.74` のような英数字と `.` の連なり。後ろは貪欲に読み (部分的に残して漏らさない)、文末の `.` は含めない。
    candidatesOf(
      withUnicodeVariants(prefixes),
      (escaped) => `(?<![${ASCII_WORD}])${escaped}-[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*`,
      SELF_ERROR_TICKET_ID_MARK,
    ),
    // `_` と `-` も境界として扱う (`beads_<名前>` や `<名前>-server` も伏せる)。
    candidatesOf(
      withUnicodeVariants(names),
      (escaped) => `(?<![${ASCII_WORD}])${escaped}(?![${ASCII_WORD}])`,
      SELF_ERROR_PROJECT_MARK,
    ),
  ];
}

/**
 * 一覧からあらかじめ探索用の正規表現を作り、何本ものエラー文に使い回せる版。探す対象が 1 つも無いときは入力をそのまま返す。
 * 探索は文字列ごとに別々の `RegExp` で行う (大きな `|` で束ねない)。一致の重なりは使用済みの表で判定するので、全体は本文の長さにほぼ比例する。
 */
export function createSelfErrorMasker(projects: readonly SelfErrorMaskProject[]): (text: string) => string {
  const groups = buildGroups(projects);
  if (groups.every((group) => group.length === 0)) return (text) => text;

  return (text) => {
    const used = new Uint8Array(text.length);
    const matches: Match[] = [];
    for (const group of groups) {
      for (const candidate of group) {
        for (const found of text.matchAll(candidate.regex)) {
          const start = found.index;
          const end = start + found[0].length;
          if (used.subarray(start, end).some((flag) => flag !== 0)) continue;
          used.fill(1, start, end);
          matches.push({ start, end, mark: candidate.mark });
        }
      }
    }
    matches.sort((a, b) => a.start - b.start);
    let output = '';
    let cursor = 0;
    for (const match of matches) {
      output += text.slice(cursor, match.start) + match.mark;
      cursor = match.end;
    }
    return output + text.slice(cursor);
  };
}

export function maskSelfErrorText(text: string, projects: readonly SelfErrorMaskProject[]): string {
  return createSelfErrorMasker(projects)(text);
}
