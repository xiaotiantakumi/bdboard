// bdboard-sso1.53: check-drift.mjs から move-only 分割。CLI エントリ本体 (「main」節)。
import { changedFiles, git } from './git.mjs';
import { computeDrift, formatDriftReport } from './compute.mjs';
import { reportOpenPullRequestOverlap } from './report.mjs';

const EXIT_OK = 0;
/** チェック自体が実行できなかった。発見あり (0) と区別する。 */
const EXIT_UNAVAILABLE = 2;

export function main(argv) {
  const upstream = 'origin/main';
  const shouldFetch = !argv.includes('--no-fetch');

  if (shouldFetch) {
    // 古い origin/main と比べた drift は意味が無い (それが検知したいものそのもの)。
    // ネットワークが無い環境向けに --no-fetch を残す。
    try {
      // bdboard-b0yd R4-F4: --prune を足す (理由は reportOpenPullRequestOverlap
      // 側の fetch と同じ)。
      git(['fetch', 'origin', 'main', '--prune', '--quiet']);
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
    reportOpenPullRequestOverlap(
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      [],
      shouldFetch,
      upstream,
    );
    return EXIT_OK;
  }

  const aheadCount = Number.parseInt(git(['rev-list', '--count', `${mergeBase}..${upstream}`]), 10);
  const drift = computeDrift(changedFiles(mergeBase, upstream), changedFiles(mergeBase, 'HEAD'));

  console.log(formatDriftReport(drift, { mergeBase, upstream, aheadCount }));
  reportOpenPullRequestOverlap(
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    changedFiles(mergeBase, 'HEAD'),
    shouldFetch,
    upstream,
  );
  return EXIT_OK;
}
