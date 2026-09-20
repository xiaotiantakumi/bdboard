// bdboard-sso1.11: HygienePanel.tsx からハーネス警告の集約関数を移動しただけの
// ファイル。挙動は一切変えていない。
import { fetchAllHarnessStatus } from '../../api';
import {
  harnessContractNeedsAttention,
  harnessHooksNeedAttention,
} from '../../harnessDisplay';
import type { HarnessHygieneItems } from './types';

/**
 * ハーネス由来の警告を1回のリクエストからまとめて作る。
 *
 * 検証コントラクトは**注入済みプロジェクトだけ**が対象で、未注入は
 * サーバー側で `not-applicable` になっている。ここでフィルタし直さないのは、
 * 「どこまでを問題扱いにするか」の判断をサーバーの1か所に集めるため
 * (bdboard-pkr6.3)。
 */
export async function fetchHarnessHygieneItems(
  projectIds: readonly string[],
): Promise<HarnessHygieneItems> {
  const batch = await fetchAllHarnessStatus();
  const filterSet = projectIds.length > 0 ? new Set(projectIds) : null;
  const entries = batch.projects.filter(
    (entry) => filterSet === null || filterSet.has(entry.projectId),
  );

  return {
    driftItems: entries.flatMap(({ projectId, packs }) =>
      packs.filter((pack) => pack.drift).map((pack) => ({ projectId, pack })),
    ),
    contractItems: entries
      .filter((entry) => harnessContractNeedsAttention(entry.contract))
      .map(({ projectId, contract }) => ({ projectId, contract })),
    hooksItems: entries.flatMap(({ projectId, packs }) =>
      packs.filter(harnessHooksNeedAttention).map((pack) => ({ projectId, pack })),
    ),
  };
}
