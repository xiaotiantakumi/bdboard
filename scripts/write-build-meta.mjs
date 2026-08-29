// bdboard-3tw.159.5: `web/dist` にビルド時点の git SHA と時刻を書き込む。
//
// なぜ vite.config.ts のプラグインではなく独立スクリプトなのか:
// dependency-cruiser のルール `no-child-process-outside-process-runners`
// (.dependency-cruiser.cjs) は、`child_process` を
// `src/infrastructure/(process|runners)/` 以外からインポートすることを禁じている。
// `check:boundaries` (`depcruise --config .dependency-cruiser.cjs src web`) は
// `web/` 配下も走査するため、`web/vite.config.ts` に `execSync` を直接書くと
// このルールに引っかかる(実測: `error no-child-process-outside-process-runners:
// web/vite.config.ts → child_process`)。`scripts/` は depcruise のスキャン対象
// (`src web`)に含まれないので、ここへ切り出すのがこの制約の下での正解
// (`scripts/verify.mjs` など、他の運用スクリプトも同様に `child_process` を
// 直接使っている)。
//
// 動機: 常時稼働サーバー(`npm run start`)は tsx を watch なしで動かし、静的な
// `web/dist` を配信するだけなので、`origin/main` へマージしても再ビルド/再起動
// しない限り古いビルドが出続ける(CLAUDE.md「Always-On Local Hosting」)。
// チャットの `deploy_status` ツール
// (`src/infrastructure/chat/deploy-status-tool.ts`)がこのファイルを読んで
// 「配信中ビルドは origin/main の何コミット前か」を答える。
//
// `package.json` の version(release-please 管理、bdboard-70z)を使わなかった
// 理由: release PR がマージされたときしか動かず、通常のマージ1件ごとには
// 変わらないため「Nコミット遅れ」を言うのに必要な粒度が出ない。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultGitRevParse() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

/**
 * ビルド時点の git SHA を決める。CI/デプロイ環境が shallow clone で `.git` を
 * 持たない(あるいは持っていても履歴が浅い)ことがあるため、環境変数を先に見る。
 * どちらも取れなければ null(build-meta.json 側は「unknown」として扱われる)。
 *
 * `gitRevParse` を差し替え可能にしてあるのはテストのため(本物の git を起動せずに
 * 分岐を確認できるようにする)。
 */
export function resolveBuildSha(env = process.env, gitRevParse = defaultGitRevParse) {
  const envSha = env.GITHUB_SHA ?? env.BDBOARD_BUILD_SHA;
  if (envSha !== undefined && envSha.length > 0) {
    return envSha;
  }
  try {
    return gitRevParse();
  } catch {
    return null;
  }
}

export function buildMetaJson(sha, builtAt) {
  return `${JSON.stringify({ sha, builtAt }, null, 2)}\n`;
}

function main() {
  const outDir = path.join(REPO_ROOT, 'web', 'dist');
  mkdirSync(outDir, { recursive: true });

  const sha = resolveBuildSha();
  const builtAt = new Date().toISOString();
  const outPath = path.join(outDir, 'build-meta.json');

  writeFileSync(outPath, buildMetaJson(sha, builtAt), 'utf8');
  console.log(`Wrote ${outPath} (sha=${sha ?? 'unknown'})`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
