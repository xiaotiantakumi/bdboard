// bdboard-ulxa.2: S2 の hot file (テキストが綺麗に混ざっても意味が壊れやすいファイル) の判定。
//
// 設計 bdboard-ulxa §2.3 / §6 裁定 3: 着地予定ツリーの verify でも検出はできるが、rebase して CI にも
// 見せた方が安い (または npm ci が不整合で「検証を実行できない」になる) ものだけを hot にする。
// eslint.config.mjs と scripts/file-size-baseline.json は入れない (lint / check:file-size が着地予定
// ツリー上で決定的に判定できる。入れると B が 22% の PR にしか効かない)。
//
// 1 要素が 1 つの「種類」。main 側の変更と自分の変更が同じ要素に当たったらクラス R (rebase)。
// 同じファイル (重なり) だけでなく同種のファイル (例: main が web/package-lock.json、自分が
// package.json) も R にする。契約の merge.hotFiles で丸ごと置き換えられる。
//
// パターンの文法 (最小限のグロブ。パスは / 区切りのリポジトリ相対):
//   *  = / を含まない 0 文字以上 / ? = / 以外の 1 文字 / ** = / を含む 0 文字以上
//   **/ = 0 個以上のディレクトリ / {a,b} = 選択 (入れ子不可)。それ以外は文字どおり
export const DEFAULT_HOT_FILES = Object.freeze([
  // 依存: 両側が依存を足すと lockfile はテキスト上混ざっても npm ci が不整合で落ちる
  '{package.json,package-lock.json,web/package.json,web/package-lock.json}',
  // CI の定義: PR の CI が見た定義と着地後の定義が違う
  '.github/workflows/**',
  // 検証系の設定: 着地予定ツリーで検出できるが、rebase して CI に見せた方が安い
  // (.claude/bdboard-harness.json は契約の verify コマンドと merge.hotFiles 自身を持つ)
  '{**/tsconfig*.json,.dependency-cruiser.*,scripts/verify*.mjs,vite.config.*,vitest.config.*,web/vite.config.*,web/vitest.config.*,.claude/bdboard-harness.json}',
  // 8192 バイト上限の SKILL.md (正本と注入コピー): 両側が足すと上限を超える
  '{harness/packs/bdboard-harness/SKILL.md,.claude/skills/bdboard-harness/SKILL.md}',
]);

// bdboard-ulxa.3 (PR #854 レビュー): S3 の軽量チェック (build + lint + check:boundaries) が中身を検査しない
// ファイル。tsc の include は src / vitest.config.ts / test/e2e だけ、depcruise は src と web だけ、scripts の
// ESLint は型情報なしで import の検査も無いので、存在しない export / モジュールを import しても軽量チェックは
// exit 0 になる (実測)。web/src は入れない — build:web の tsc --noEmit (web/tsconfig.json の include は src) が型と import を検査する。
// main 側と自分の両方がどれかの要素に当たったら (同じ要素でなくても) クラス L にしない (片側だけなら L のまま)。
// hot file ではない (hotFiles に足すと S2 の R まで増える) ので、契約の別キー merge.lightBlindFiles で丸ごと置き換える。
export const DEFAULT_LIGHT_BLIND_FILES = Object.freeze(['scripts/**']);

// マージ手順自身 (merge-pr と、その前段の drift)。片側だけの変更でもクラス L にしない — 軽量チェックが見落とした
// 壊れ方で着地すると、取り込んだ全エージェントの merge-pr が起動時に落ち、修復 PR もこの手順で入れられない。
// 契約では変えられない。scripts/merge-pr.mjs から import で辿れる scripts/ の外部モジュールも含める
// (漏れは merge-pr.s3.test.mjs が import を辿って落とす)。
export const MERGE_PROCEDURE_FILES = Object.freeze([
  'scripts/merge-pr/**',
  'scripts/merge-pr.mjs',
  'scripts/check-drift/**',
  'scripts/check-drift.mjs',
  'scripts/process-identity.mjs',
  'scripts/process-tree.mjs',
  'scripts/verify-slot.mjs',
  'scripts/verify-slot-files.mjs',
  'scripts/verify-slot-queue.mjs',
]);

const LITERAL = /[.+^$()|[\]\\]/g;

function compile(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      const body = end === -1 ? '' : glob.slice(i + 1, end);
      if (end === -1 || body.includes('{') || body === '') {
        throw new Error(`hot file パターンの {} が不正です: ${glob}`);
      }
      out += `(?:${body.split(',').map(compile).join('|')})`;
      i = end;
    } else if (c === '}') {
      throw new Error(`hot file パターンの } が対応していません: ${glob}`);
    } else {
      out += c.replace(LITERAL, '\\$&');
    }
  }
  return out;
}

/** グロブを完全一致の正規表現にする。不正なパターンは throw。 */
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.trim() === '') {
    throw new Error('hot file パターンは空でない文字列です');
  }
  return new RegExp(`^${compile(glob)}$`);
}

/**
 * どれかの hot パターンに当たるファイルを返す (bdboard-ulxa.3: S3 のクラス L は、片側だけの hot file
 * でも軽量チェックにしない)。
 * @returns {string[]}
 */
export function hotTouched(files, patterns) {
  const res = patterns.map(globToRegExp);
  return files.filter((file) => res.some((re) => re.test(file)));
}

/**
 * main 側の変更ファイルと自分の変更ファイルが同じ hot パターンに当たるものを返す。
 * @returns {{ pattern: string, main: string[], mine: string[] }[]} 空なら hot の衝突なし
 */
export function hotCollisions(mainFiles, mineFiles, patterns) {
  const hits = [];
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    const main = mainFiles.filter((file) => re.test(file));
    const mine = mineFiles.filter((file) => re.test(file));
    if (main.length > 0 && mine.length > 0) {
      hits.push({ pattern, main, mine });
    }
  }
  return hits;
}
