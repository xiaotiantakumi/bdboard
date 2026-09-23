// bdboard-sso1.53: check-drift.mjs から move-only 分割。git 呼び出しと merge-tree 判定 (「git ヘルパー」節)。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `git merge-tree --write-tree --name-only` の stdout から衝突ファイルだけを取る。
 *
 * `git merge-tree --help` の OUTPUT > "Informational messages" が契約を明記している:
 * - 非 -z 出力では情報セクションの先頭に必ず空行が入り、前のセクションと区切られる。
 * - 情報行は非安定であり、スクリプトでパースしてはいけない。
 * - conflict-message 自体が埋め込み改行を持つ場合もある。
 * したがって OID の次から最初の空行までだけをパスとして扱う。英語接頭辞の
 * ブラックリストでは de_DE.UTF-8 の翻訳済みメッセージを除外できない。
 */
export function parseMergeTreeConflictFiles(output) {
  const lines = output.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length <= 1) {
    return [];
  }

  const informationBoundary = lines.indexOf('', 1);
  if (informationBoundary === -1) {
    // 衝突出力なら仕様上は必ず境界がある。未知の出力で空を返すと実パスを黙って
    // 取りこぼすため、OID 以降を上界として残す。後段では自分の変更パスとの積集合を
    // 取るので、余計な行を拾うリスクより衝突を見逃すリスクを優先する。
    return lines.slice(1);
  }
  return lines.slice(1, informationBoundary);
}

export function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function changedFiles(from, to) {
  // --no-renames が要。既定の rename 検出だと、main 側が a.ts を b.ts へ改名して
  // 中身も変えた場合に新パス b.ts しか出ず、旧パス a.ts を触っているブランチとの
  // 重なりが消える。実際に rebase すると衝突するので、「重なりは上界」という
  // このコマンドの前提そのものが破れる (fable レビューで再現あり)。--no-renames なら
  // 削除+追加として両パスが出て、上界として正しくなる。改名だけで中身を変えていない
  // ケースは rebase が通るので、これで増える誤検知はほぼ無い。
  //
  // core.quotepath=false は非ASCIIのパスが \346\227\245 のような8進エスケープで
  // 出るのを止めるだけ (検出そのものには影響しない)。
  const out = git([
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    '--no-renames',
    `${from}..${to}`,
  ]);
  return out === '' ? [] : out.split('\n');
}

/**
 * `ancestor` が `ref` の祖先かどうかを判定する。
 *
 * bdboard-b0yd R2-2/R2-3: `git merge-base --is-ancestor` 1本で両方の判定が
 * 賄える。exit 0 = ancestor である、exit 1 = ない。それ以外 (無関係な commit-ish
 * 等) は呼び出し側の catch に判断を委ねるため再 throw する。
 */
export function isAncestor(ancestor, ref) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, ref]);
    return true;
  } catch (error) {
    if (error.status === 1) {
      return false;
    }
    throw error;
  }
}

export function mergeTree(ref, { mergeBase } = {}) {
  try {
    // changedFiles() と表記を揃えないと、非ASCIIパスが8進エスケープされて積集合から
    // 消える。引用符・バックスラッシュ・制御文字を含むパスでも C クオートが起こる。
    // LC_ALL=C も固定し、構造パースに加えて情報メッセージのロケール軸を二重に塞ぐ。
    const args = ['-c', 'core.quotepath=false', 'merge-tree', '--write-tree', '--name-only'];
    if (mergeBase) {
      // bdboard-b0yd R2-2: peer が origin/main を既に取り込み済み (呼び出し側が
      // 確認済み) のときだけ渡される。3-way base を明示的に現在の main に固定し、
      // peer 側の古い自然な merge-base に起因する「main と peer の衝突」が
      // 「自分と peer の衝突」に化けるのを防ぐ。
      args.push(`--merge-base=${mergeBase}`);
    }
    args.push('HEAD', ref);
    git(args, { env: { ...process.env, LC_ALL: 'C' } });
    return { status: 'clean' };
  } catch (error) {
    // merge-tree はテキスト衝突を exit 1 で知らせる。execFileSync は非ゼロを
    // throw するので、ここでだけ正常な「衝突あり」として stdout を読む。
    if (error.status === 1) {
      return {
        status: 'conflict',
        files: parseMergeTreeConflictFiles(String(error.stdout ?? '')),
      };
    }
    // bdboard-b0yd R2-5: 古い git の未知オプション、unrelated histories などは
    // 階層1を諦めるが、以前はここで理由を握り潰していた。呼び出し側が
    // 「ファイル単位でのみ比較した」と明示できるよう理由を残す。
    const reason = String(error?.stderr || error?.message || error)
      .replace(/\s+/g, ' ')
      .trim();
    return { status: 'unavailable', reason };
  }
}
