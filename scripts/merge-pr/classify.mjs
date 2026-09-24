// bdboard-ulxa.2: S2 の分類 (設計 §2.3) — main が PR head の祖先でない (main が動いた) ときに、
// rebase が要るか (R)、rebase せず着地予定ツリーを verify すればよいか (F) を決める。
//
//   R = merge-base が 1 個でない / merge-tree がテキスト衝突 / merge-tree を実行できない /
//       main 側と自分の変更が同じ hot パターンに当たる (hot-files.mjs)
//   F = それ以外。着地予定ツリー (merge-tree の結果) を prepare が verify する
//
// ファイルの重なりは採否の判定に使わない (§3.2: 重なりも merge-tree もテキストの判定で、意味的
// 衝突は着地する木を build / lint / test しないと分からない)。重なりの件数は監査ログにだけ残す
// (S3 の軽量チェックを選ぶときの材料)。
//
// 着地予定ツリーは `git merge-tree --write-tree <origin/main> <PR head>` (--merge-base を渡さない
// = 自然な merge-base)。GitHub の squash マージが作る木 = その時点の main に head を 3-way マージした
// 木なので、gate の CAS (main == PRED_BASE) と --match-head-commit (head == PR head) が成り立てば
// 着地する木はこの木と同じになる。finish が着地後に木の SHA を突き合わせて確かめる。
import { parseMergeTreeConflictFiles } from '../check-drift/git.mjs';
import { run } from './exec.mjs';
import { hotCollisions } from './hot-files.mjs';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function gitLines(ctx, args, separator = '\n') {
  const result = run('git', args, { cwd: ctx.cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.split(separator).map((line) => line.trim()).filter((line) => line !== '');
}

function changed(ctx, from, to) {
  // --no-renames: 改名は削除 + 追加の両パスとして出す (check-drift の changedFiles と同じ理由)。
  return gitLines(ctx, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', '-z', `${from}..${to}`], '\0');
}

function mergeBases(ctx, mainSha, head) {
  const result = run('git', ['merge-base', '--all', mainSha, head], { cwd: ctx.cwd });
  // exit 1 + 空 = 共通の祖先なし。それ以外の失敗も「1 個ではない」として R に倒す。
  return result.status === 0 ? result.stdout.split('\n').filter((line) => OID.test(line.trim())) : [];
}

/** merge-tree の結果を読む。exit 0 = clean、1 = テキスト衝突、それ以外 = 実行できない。 */
export function readMergeTree({ status, stdout, stderr }) {
  const first = stdout.split('\n')[0].trim();
  if (status === 0 && OID.test(first)) {
    return { status: 'clean', tree: first };
  }
  if (status === 1 && OID.test(first)) {
    return { status: 'conflict', files: parseMergeTreeConflictFiles(stdout) };
  }
  const reason = `${stderr}`.replace(/\s+/g, ' ').trim() || `exit ${status}`;
  return { status: 'unavailable', reason };
}

// 利用者の gitconfig で木が変わらないよう改名検出を既定値に固定する (directoryRenames=true / false
// だと衝突にならず別々の木になる。conflict なら R に倒れる)。
const MERGE_CONFIG = ['-c', 'core.quotepath=false', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=conflict'];

function mergeTree(ctx, mainSha, head) {
  const result = run('git', [...MERGE_CONFIG, 'merge-tree', '--write-tree', '--name-only', mainSha, head], {
    cwd: ctx.cwd,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return readMergeTree(result);
}

function describeHot(hits) {
  return hits.map((hit) => `main ${hit.main.join(', ')} / 自分 ${hit.mine.join(', ')}`).join('; ');
}

/** 材料から S2 のクラスを決める純関数。 */
export function decideS2Class({ baseCount, merge, hot }) {
  if (baseCount !== 1) {
    const why = baseCount === 0 ? '共通の祖先がありません (または merge-base を実行できません)' : `merge-base が ${baseCount} 個あります (criss-cross)`;
    return { class: 'R', reason: why };
  }
  if (merge.status === 'conflict') {
    return { class: 'R', reason: `テキスト衝突: ${merge.files.join(', ') || '(ファイル名を読めませんでした)'}` };
  }
  if (merge.status !== 'clean') {
    return { class: 'R', reason: `git merge-tree を実行できません: ${merge.reason}` };
  }
  if (hot.length > 0) {
    return { class: 'R', reason: `hot file: ${describeHot(hot)}` };
  }
  return { class: 'F', reason: '衝突なし・hot file なし', tree: merge.tree };
}

/**
 * main (mainSha) が head の祖先でないときの S2 の分類。
 * @returns {{ class: 'R'|'F', reason: string, tree?: string, base?: string, mainFiles: string[], mineFiles: string[], overlap: string[] }}
 */
export function classifyS2(ctx, mainSha, head) {
  try {
    return classifyMoved(ctx, mainSha, head);
  } catch (error) {
    // git が失敗したら分類できない = rebase 側 (R) に倒す。「想定外」の exit 1 にしない。
    const reason = `git で分類できません: ${error instanceof Error ? error.message : String(error)}`;
    return { class: 'R', reason, mainFiles: [], mineFiles: [], overlap: [] };
  }
}

function classifyMoved(ctx, mainSha, head) {
  const bases = mergeBases(ctx, mainSha, head);
  if (bases.length !== 1) {
    return { ...decideS2Class({ baseCount: bases.length, merge: null, hot: [] }), mainFiles: [], mineFiles: [], overlap: [] };
  }
  const [base] = bases;
  const mainFiles = changed(ctx, base, mainSha);
  const mineFiles = changed(ctx, base, head);
  const mine = new Set(mineFiles);
  const overlap = mainFiles.filter((file) => mine.has(file));
  const merge = mergeTree(ctx, mainSha, head);
  const hot = hotCollisions(mainFiles, mineFiles, ctx.config.hotFiles);
  return { ...decideS2Class({ baseCount: 1, merge, hot }), base, mainFiles, mineFiles, overlap };
}
