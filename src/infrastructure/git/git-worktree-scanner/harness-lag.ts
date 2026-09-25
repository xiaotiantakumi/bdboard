import type { HarnessLagMeasurement } from '../../../application/ports/worktree-scanner.js';
import { isSafeMainBranchName } from '../../../domain/harness-contract.js';
import type { ScannerDeps } from './deps.js';
import { runGitReadOnly } from './git-command.js';
import { MERGE_BASE_CANDIDATE_REFS } from './merge-base.js';

/**
 * ハーネスの実体があるパス。`countHarnessCommitsBehindDefaultBranch` の pathspec。
 *
 * 総コミット数で「凍っている」を測ると意味がリポジトリの速度に振り回される (この repo は
 * 1 日 90 前後動くので、同じ 50 が日によって半日にも 4 日にもなる)。**知りたいのは
 * 「ハーネスが何コミットぶん古いか」**なので、それを直接数える。
 *
 * `.claude` は注入コピー (skills / settings.json / hooks)、`harness` は正本パック。
 * どちらかが動いていれば、その worktree のセッションは古い規律で走っている。
 */
const HARNESS_PATHS: readonly string[] = ['.claude', 'harness'];

export async function countHarnessCommitsBehindDefaultBranch(
  deps: ScannerDeps,
  worktreePath: string,
  options?: { readonly mainBranch?: string },
): Promise<HarnessLagMeasurement> {
  const { commandRunner, gitPath, timeoutMs } = deps;
  // コントラクトの mainBranch を優先し、その ref が無ければ既定の候補順へ落ちる
  // (bdboard-pkr6.19)。worktree の provisioner (origin/<mainBranch> 以外は no-base-ref で
  // 失敗) より緩いのは、こちらが「測るだけ」だから — 測れた ref は baseRef として
  // 文言とコマンドにそのまま出るので、別の ref で測っても利用者を取り違えさせない。
  // 省略時の mainBranch は parse 時点で main に埋まるため、明示か省略かは区別できない。
  const mainBranch = options?.mainBranch;
  const preferredRefs =
    mainBranch !== undefined && isSafeMainBranchName(mainBranch)
      ? [`origin/${mainBranch}`, mainBranch]
      : [];
  const candidateRefs = [...new Set([...preferredRefs, ...MERGE_BASE_CANDIDATE_REFS])];

  for (const ref of candidateRefs) {
    const result = await runGitReadOnly(
      commandRunner,
      gitPath,
      worktreePath,
      ['rev-list', '--count', `HEAD..${ref}`, '--', ...HARNESS_PATHS],
      timeoutMs,
    );
    if (result.exitCode !== 0) {
      // その ref が無いだけかもしれないので次の候補へ。全部落ちたら下で throw する。
      continue;
    }
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isFinite(parsed)) {
      return {
        commitsBehind: parsed,
        baseRef: ref,
        hasCommonAncestor: await hasCommonAncestorWith(deps, worktreePath, ref),
      };
    }
  }

  throw new Error(
    `could not count harness commits behind ${candidateRefs.join(' / ')} ` +
      `in ${worktreePath}`,
  );
}

/**
 * HEAD と ref に共通の祖先があるかを `git merge-base` の exit code で判定する
 * (bdboard-0chq)。harness/packs/bdboard-harness/hooks/worktree-freshness.sh の
 * NO_BASE 判定と同じ規則を踏襲する: **exit 1 だけが「祖先なし」**。それ以外の失敗
 * (オブジェクト破損など) は判定せず true を返す (従来どおり rebase 案内のまま扱う)。
 * shallow clone では merge-base が見えないだけのことがあるので、shallow なら
 * 判定せず true を返す。
 */
async function hasCommonAncestorWith(
  deps: ScannerDeps,
  worktreePath: string,
  ref: string,
): Promise<boolean> {
  const { commandRunner, gitPath, timeoutMs } = deps;
  const mergeBase = await runGitReadOnly(
    commandRunner,
    gitPath,
    worktreePath,
    ['merge-base', 'HEAD', ref],
    timeoutMs,
  );
  if (mergeBase.exitCode !== 1) {
    return true;
  }
  const shallow = await runGitReadOnly(
    commandRunner,
    gitPath,
    worktreePath,
    ['rev-parse', '--is-shallow-repository'],
    timeoutMs,
  );
  return shallow.stdout.trim() === 'true';
}
