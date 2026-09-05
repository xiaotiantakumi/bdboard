// bdboard-ky15: オープン中のブランチと origin/main が「同じファイル」を触り始めた
// ことを、マージ直前ではなく作業中に知らせる。
//
// 背景 (bdboard-3tw.152 / PR #86): 17時にオープンした PR が翌朝マージされるまでの間に、
// 無関係な5つの PR が同じ StatusPill.tsx / index.css を触って main へ着地し、最終
// rebase で実テキスト衝突になった。既存の Merge serialization 手順ではこれを防げない:
// - merge-slot と CAS が守るのは「マージ直前の瞬間」に main が動いたかどうかで、
//   PR が生きている数時間〜1日の間に積み上がる衝突ではない。
// - main 側の `npm run verify` はマージ後の意味的非互換を捕まえるが、事前の警告に
//   ならない (壊れてから分かる)。
//
// ここで見るのは「マージベース以降に main が触ったファイル」と「同じくブランチが
// 触ったファイル」の積集合だけ。これは rebase したときに衝突しうるファイルの上界で、
// 実際に衝突するかはハンク次第 (別関数を触っていれば衝突しない)。だから判定ではなく
// 早期警告として扱い、**発見をゲートにしない** (重なりがあっても exit 0) — ゲートに
// すると「衝突しないのに止まる」誤検知でいずれ無視されるようになる。
// 逆に「チェック自体が実行できなかった」ときだけ exit 2 を返す。これを 0 と混ぜると、
// stdout だけ拾う呼び出し側から見て「調べて問題なし」と区別が付かなくなる。
//
// 見るのは **コミット済みの変更だけ**。作業ツリーの未コミット編集は入らない。
//
// 「hot file の一覧を CLAUDE.md に載せる」案 (チケットの候補2) は採らなかった。
// どのファイルが hot かは時期で変わり、手で書いた一覧は必ず腐る。マージベースから
// 計算すれば常に現在の事実になる。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 衝突しうるファイルの積集合。純関数なのでテストはここを見る。
 *
 * どちらも「マージベース以降に触られたパス」の集合。順序は main 側の並び
 * (git の出力順 = パス辞書順) を保つ。
 */
export function computeDrift(mainFiles, branchFiles) {
  const branchSet = new Set(branchFiles);
  const seen = new Set();
  const overlap = [];

  for (const file of mainFiles) {
    if (!branchSet.has(file) || seen.has(file)) {
      continue;
    }
    seen.add(file);
    overlap.push(file);
  }

  return {
    overlap,
    mainFileCount: new Set(mainFiles).size,
    branchFileCount: branchSet.size,
  };
}

/**
 * `git merge-tree --write-tree --name-only` の stdout から衝突ファイルだけを取る。
 *
 * 衝突時は先頭に result tree の OID が出て、その後に --name-only のパスと git の
 * 情報行が混ざる。情報行の文言は git バージョンで変わり得るので、既知のメッセージ
 * 接頭辞と OID を除外し、残りをパスとして扱う。
 */
export function parseMergeTreeConflictFiles(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !/^[0-9a-f]{40,64}$/i.test(line) &&
        !/^(?:Auto-merging |CONFLICT(?: \([^)]*\))?: |Automatic merge failed|fatal: |error: |warning: )/.test(line),
    );
}

/**
 * 人間 (とエージェント) 向けの本文。exit code は持たせない。
 *
 * upstream が動いていない / ブランチが何も触っていないケースを先に畳むのは、
 * 「重なり0件」を毎回同じ文で出すと、本当に0件なのか比較する材料が無いのかが
 * 区別できなくなるため。
 */
export function formatDriftReport(drift, ctx) {
  const { mergeBase, upstream, aheadCount } = ctx;
  const head = `drift: merge-base ${mergeBase.slice(0, 7)} 以降、${upstream} は ${aheadCount} コミット進んでいます。`;

  if (aheadCount === 0) {
    return `${head}\ndrift: 重なりようがありません (rebase 不要)。`;
  }
  if (drift.branchFileCount === 0) {
    return `${head}\ndrift: このブランチはまだファイルを変更していません。`;
  }

  if (drift.overlap.length === 0) {
    return (
      `${head}\n` +
      `drift: 重なるファイルはありません` +
      ` (${upstream} 側 ${drift.mainFileCount} ファイル / ブランチ側 ${drift.branchFileCount} ファイル)。`
    );
  }

  const list = drift.overlap.map((file) => `  ${file}`).join('\n');
  return (
    `${head}\n` +
    `drift: ${upstream} とこのブランチが両方触ったファイルが ${drift.overlap.length} 件あります:\n` +
    `${list}\n` +
    `drift: 今のうちに rebase してください — 衝突が出るならこの中です。\n` +
    `drift:   git fetch origin && git rebase ${upstream}\n` +
    `drift: (ハンクが離れていれば衝突しません。これは上界であって判定ではありません。)`
  );
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const EXIT_OK = 0;
/** チェック自体が実行できなかった。発見あり (0) と区別する。 */
const EXIT_UNAVAILABLE = 2;

function changedFiles(from, to) {
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

function listOpenPullRequests() {
  try {
    // drift は必須ゲートなので、GitHub API の障害で止めない。execFileSync は gh の
    // 非ゼロ終了でも throw するため、timeout・認証/API エラー・JSON 壊れをすべてここで
    // 非致命として扱う。shell を通さないので branch 名もコマンドとして解釈されない。
    const output = execFileSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    const pullRequests = JSON.parse(output);
    if (!Array.isArray(pullRequests) || pullRequests.some((pr) => !Number.isInteger(pr.number) || typeof pr.headRefName !== 'string')) {
      throw new Error('unexpected gh JSON');
    }
    return { pullRequests };
  } catch {
    return { error: 'drift: open PR を取得できなかったため、他 PR との比較を省略しました。' };
  }
}

function mergeTree(ref) {
  try {
    git(['merge-tree', '--write-tree', '--name-only', 'HEAD', ref]);
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
    // 古い git の未知オプション、unrelated histories などは階層1を諦め、階層2
    // （同じファイル）の警告だけを続ける。
    return { status: 'unavailable' };
  }
}

function reportOpenPullRequestOverlap(currentBranch, branchFiles) {
  const listed = listOpenPullRequests();
  if (listed.error) {
    console.error(listed.error);
    return;
  }

  const skippedAutomatic = [];
  const skippedMissingRef = [];
  const conflicts = [];
  const sharedFileOverlaps = [];
  let comparedCount = 0;

  for (const pr of listed.pullRequests) {
    if (pr.headRefName === currentBranch) {
      continue;
    }
    // release-please は package version/changelog を main の内容から自動生成する。
    // 作業中の機能ブランチとのマージ順を人が決める対象ではないのでノイズを避けて除外する。
    if (pr.headRefName.startsWith('release-please--')) {
      skippedAutomatic.push(pr);
      continue;
    }

    const ref = `origin/${pr.headRefName}`;
    try {
      git(['rev-parse', '--verify', '--quiet', ref]);
    } catch {
      skippedMissingRef.push(pr);
      continue;
    }

    try {
      comparedCount += 1;
      const mergeResult = mergeTree(ref);
      if (mergeResult.status === 'conflict') {
        // merge-tree の3-way base は peer と HEAD の merge-base なので、古い base
        // の peer 自身が main へ rebase できない衝突もここに混ざる。我々が実際に
        // 触ったファイルだけに絞れば、それは我々とのマージ順を決める材料になる。
        const files = computeDrift(mergeResult.files, branchFiles).overlap;
        if (files.length > 0) {
          conflicts.push({ pr, files });
          continue;
        }
      }

      const peerMergeBase = git(['merge-base', 'origin/main', ref]);
      const peerFiles = changedFiles(peerMergeBase, ref);
      const files = computeDrift(peerFiles, branchFiles).overlap;
      if (files.length > 0) {
        sharedFileOverlaps.push({ pr, files });
      }
    } catch {
      // ローカル参照が途中で消えた等でも、origin/main の既存判定を妨げない。
      skippedMissingRef.push(pr);
    }
  }

  if (conflicts.length === 0 && sharedFileOverlaps.length === 0) {
    console.log(`drift: open PR ${comparedCount} 件との重なりはありません。`);
  } else {
    for (const { pr, files } of conflicts) {
      console.log(`drift: open PR #${pr.number} (${pr.headRefName}) と衝突します (rebase でテキスト衝突):`);
      for (const file of files) {
        console.log(`  ${file}`);
      }
    }
    for (const { pr, files } of sharedFileOverlaps) {
      console.log(`drift: open PR #${pr.number} (${pr.headRefName}) と同じファイルを触っています (衝突はしませんが意味的な整合は要確認):`);
      for (const file of files) {
        console.log(`  ${file}`);
      }
    }
    console.log('drift: マージ順は議長が決めてください (これは報告であり、終了コードには影響しません)。');
  }
  if (skippedMissingRef.length > 0) {
    console.log(`drift: リモート追跡ブランチがないため比較を省略しました (${skippedMissingRef.map((pr) => `PR #${pr.number}`).join(', ')})。`);
  }
  if (skippedAutomatic.length > 0) {
    console.log(`drift: release-please の自動生成 PR は比較から除外しました (${skippedAutomatic.map((pr) => `PR #${pr.number}`).join(', ')})。`);
  }
}

function main(argv) {
  const upstream = 'origin/main';
  const shouldFetch = !argv.includes('--no-fetch');

  if (shouldFetch) {
    // 古い origin/main と比べた drift は意味が無い (それが検知したいものそのもの)。
    // ネットワークが無い環境向けに --no-fetch を残す。
    try {
      git(['fetch', 'origin', 'main', '--quiet']);
    } catch (error) {
      console.error(`drift: git fetch に失敗しました。手元の ${upstream} で続けます (${error.message.trim()})`);
    }
  }

  let mergeBase;
  try {
    mergeBase = git(['merge-base', upstream, 'HEAD']);
  } catch {
    console.error(
      `drift: ${upstream} と HEAD の merge-base が取れませんでした。` +
        ' origin remote があり、origin/main を fetch 済みかを確認してください。',
    );
    return EXIT_UNAVAILABLE;
  }

  if (mergeBase === git(['rev-parse', 'HEAD'])) {
    console.log('drift: HEAD が merge-base そのものです (このブランチにはまだコミットがありません)。');
    reportOpenPullRequestOverlap(git(['rev-parse', '--abbrev-ref', 'HEAD']), []);
    return EXIT_OK;
  }

  const aheadCount = Number.parseInt(git(['rev-list', '--count', `${mergeBase}..${upstream}`]), 10);
  const drift = computeDrift(changedFiles(mergeBase, upstream), changedFiles(mergeBase, 'HEAD'));

  console.log(formatDriftReport(drift, { mergeBase, upstream, aheadCount }));
  reportOpenPullRequestOverlap(
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    changedFiles(mergeBase, 'HEAD'),
  );
  return EXIT_OK;
}

// pathToFileURL を使う。`file://${argv[1]}` だと、リポジトリのパスに空白や非ASCIIが
// 含まれるときに import.meta.url 側だけがパーセントエンコードされて一致せず、
// main() が走らないまま無言で exit 0 になる (fable レビューで再現あり)。
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
