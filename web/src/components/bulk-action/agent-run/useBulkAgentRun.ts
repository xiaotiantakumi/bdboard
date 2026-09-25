// bdboard-mkm1.2: 一括操作バーの「▶ 実行」の state とハンドラ。実行そのものは
// App が持つ実行ループのコントローラ (useNextUpRunLoopController) に ID の配列を
// 渡すだけで、ループ本体・サーバー側の実行経路 (POST /api/runs) には手を入れない。
import { type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import type { BoardCardDto, BoardViewDto } from '../../../api';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useAllHarnessStatuses } from '../../../hooks/useHarnessStatusData';
import type { BulkSelectionContextValue } from '../../BulkSelectionProvider';
import type { NextUpLoopProgress, NextUpRunLoopController } from '../../nextUpRunLoop';
import {
  type BulkRunPlan,
  buildBulkRunPlan,
  collectReadyDisplayOrder,
  describeBulkRunHarnessBlock,
} from './bulkRunPlan';

/** BulkActionBar に「▶ 実行」を出すための入力。渡さなければボタン自体を出さない。 */
export interface BulkAgentRunConfig {
  readonly batchRun: NextUpRunLoopController;
  /** 実行順を画面の表示順に揃えるための盤面 (未取得なら優先度だけで並ぶ)。 */
  readonly board: BoardViewDto | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
}

export interface UseBulkAgentRunParams {
  readonly config: BulkAgentRunConfig | undefined;
  readonly bulkSelection: BulkSelectionContextValue | null;
  readonly cardsById: ReadonlyMap<string, BoardCardDto>;
  /** 他の一括操作の確認中・送信中。重ねて開かせない。 */
  readonly barBusy: boolean;
}

export interface BulkAgentRun {
  readonly enabled: boolean;
  readonly plan: BulkRunPlan;
  readonly harnessBlockReason: string | null;
  /** ボタンを押せない理由 (title とボタン下の 1 行に出す)。押せるなら null。 */
  readonly runDisabledReason: string | null;
  readonly confirmOpen: boolean;
  readonly canConfirm: boolean;
  readonly confirmPanelRef: RefObject<HTMLDivElement | null>;
  readonly cancelConfirmRef: RefObject<HTMLButtonElement | null>;
  readonly openConfirm: () => void;
  readonly cancelConfirm: () => void;
  readonly confirmRun: () => void;
}

export const BULK_RUN_LOOP_ACTIVE_REASON =
  '一括実行中です。進捗の確認と停止はヘッダーのチップから行えます';
export const BULK_RUN_HARNESS_CHECKING_REASON = 'ハーネスの状態を確認しています…';

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

interface PendingConfirm {
  readonly selection: ReadonlySet<string>;
  readonly progress: NextUpLoopProgress;
}

export function useBulkAgentRun({
  config,
  bulkSelection,
  cardsById,
  barBusy,
}: UseBulkAgentRunParams): BulkAgentRun {
  const board = config?.board;
  const projectNames = config?.projectNames;
  const loopActive = config !== undefined && config.batchRun.phase !== 'idle';
  const selectedIds = bulkSelection?.selectedIds ?? EMPTY_SELECTION;
  // ハーネスの前提は選択があるときだけ引く (useAllHarnessStatuses は queryKey 固定で
  // 他の呼び出し元ともキャッシュを共有する)。
  // 取得に失敗したら「不明」として止めない — 最終判定はサーバーの preflight。
  const harness = useAllHarnessStatuses(config !== undefined && selectedIds.size > 0);
  const harnessStatuses =
    harness.harnessStatusQuery.data !== undefined ? harness.harnessStatuses : undefined;
  // 初回取得中だけ止める。取得に失敗した後の再取得 (フォーカス復帰など) では止めない。
  const harnessChecking = harness.harnessStatusQuery.isLoading;

  const readyDisplayOrder = useMemo(() => collectReadyDisplayOrder(board), [board]);
  const plan = useMemo(
    () => buildBulkRunPlan(selectedIds, cardsById, readyDisplayOrder),
    [selectedIds, cardsById, readyDisplayOrder],
  );
  const harnessBlockReason = useMemo(
    () =>
      projectNames === undefined
        ? null
        : describeBulkRunHarnessBlock(plan.runCards, harnessStatuses, projectNames),
    [plan, harnessStatuses, projectNames],
  );
  const runDisabledReason = loopActive
    ? BULK_RUN_LOOP_ACTIVE_REASON
    : harnessChecking
      ? BULK_RUN_HARNESS_CHECKING_REASON
      : harnessBlockReason;

  // 開いた時点の選択 (Set の参照) と実行ループの進捗 (参照) を覚えておき、どちらかが
  // 変わったら確認は自動的に閉じた扱いにする。選択が変わる (トグル・全解除・実行開始
  // による解除) — 古い選択のまま実行させない / バーが一度消えて再び出たときに開きっぱなしで
  // 戻らない。進捗が変わる — 確認中に何らかの理由でループが
  // 始まったら、そのループが終わった後に確認がひとりでに開き直らない (beginBatchRun は
  // 必ず progress を差し替える)。
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmOpen =
    config !== undefined &&
    pending !== null &&
    pending.selection === bulkSelection?.selectedIds &&
    pending.progress === config.batchRun.progress &&
    !loopActive;
  const canConfirm = confirmOpen && plan.runTicketIds.length > 0 && runDisabledReason === null;
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);

  const openConfirm = useCallback(() => {
    if (config === undefined || bulkSelection === null || barBusy || runDisabledReason !== null) {
      return;
    }
    setPending({ selection: bulkSelection.selectedIds, progress: config.batchRun.progress });
  }, [barBusy, bulkSelection, config, runDisabledReason]);

  const cancelConfirm = useCallback(() => {
    setPending(null);
  }, []);

  const confirmRun = useCallback(() => {
    if (config === undefined || !canConfirm) {
      return;
    }
    config.batchRun.beginBatchRun(plan.runTicketIds);
    setPending(null);
    // 実行を始めたカードを選んだままにすると、次の一括操作で誤って巻き込みやすい。
    bulkSelection?.clear();
  }, [bulkSelection, canConfirm, config, plan]);

  // 他の alertdialog (一括操作の確認) と同じくフォーカスを閉じ込め、
  // 初期フォーカスは実行側ではなくキャンセル側に置く。
  useFocusTrap({
    containerRef: confirmPanelRef,
    initialFocusRef: cancelConfirmRef,
    enabled: confirmOpen,
    onEscape: cancelConfirm,
  });

  return {
    enabled: config !== undefined,
    plan,
    harnessBlockReason,
    runDisabledReason,
    confirmOpen,
    canConfirm,
    confirmPanelRef,
    cancelConfirmRef,
    openConfirm,
    cancelConfirm,
    confirmRun,
  };
}
