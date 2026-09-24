import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PriorityCeilingChoice } from '../uiPersistedState/priorityCeiling';
import type { ViewMode } from '../uiPersistedState/view';
import {
  findDefaultBoardFilterPreset,
  hasStoredBoardFilterState,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from '../uiPersistedState';

// usePersistedState が返す完全な setter 形 ((value: T | ((prev: T) => T)) => void)
// と揃える。useBoardFilterState.ts の PersistedSetter<T> と同じ意図
// (関数更新式を受け付けられるようにしておく、PR #649 レビュー指摘)。
type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

export interface AppFilterPresetsParams {
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
  hideDone: boolean;
  stalledOnly: boolean;
  setView: PersistedSetter<ViewMode>;
  setSelectedProjectIds: PersistedSetter<string[]>;
  setPriorityCeiling: PersistedSetter<PriorityCeilingChoice>;
  setIssueTypes: PersistedSetter<string[]>;
  setLabels: PersistedSetter<string[]>;
  setFilterText: PersistedSetter<string>;
  setHideDone: PersistedSetter<boolean>;
  setStalledOnly: PersistedSetter<boolean>;
  boardFilterPresets: readonly BoardFilterPreset[];
}

export interface AppFilterPresetsResult {
  boardFilterPresetState: BoardFilterPresetState;
  handleApplyBoardFilterPreset: (preset: BoardFilterPreset) => void;
}

/**
 * App.tsx のボードフィルタ「プリセット」まわり(現在の絞り込み状態のスナップ
 * ショット boardFilterPresetState、プリセット適用ハンドラ、初回起動時の
 * 「既定」プリセット自動適用 effect)をひとまとめにするフック(bdboard-62p4 第5段)。
 *
 * hook 呼び出し順について: 元の App.tsx ではこの3つ(useMemo/useCallback/
 * useEffect、加えて内部で使う hadStoredFilterStateAtStartup の useState と
 * defaultPresetHandledRef の useRef)は、useAppOverlays の直後・データ取得9系統
 * (useProjectsData 等)より前で宣言されていた。このフックも App.tsx 内の同じ
 * 位置で1回だけ呼ぶため、内部の useState/useRef/useMemo/useCallback/useEffect は
 * 全体で見ても元と同じ相対位置で登録される。
 *
 * なぜこの位置(データ取得9系統より前)である必要があるか: useProjectsData 内の
 * プロジェクト絞り込み sanitize effect は projectsQuery.data に依存し、元の
 * コードでは「既定プリセット適用 effect」→「sanitize effect」の順で実行されて
 * いた(同一コミット内で setSelectedProjectIds が2回連続で呼ばれる際の実行順)。
 * この並びを崩す(データ取得9系統を先に呼ぶ)と、初回マウント時に
 * projectsQuery のデータが既にキャッシュ済みだと sanitize が先に走り、既定
 * プリセットが上書きするはずのサニタイズ結果を今度はプリセット適用が上書き
 * してしまう逆転が起きる。それを避けるため、この位置をそのまま踏襲する。
 *
 * 「既定」プリセットは、この端末にまだ絞り込み状態が1つも保存されていないとき
 * (= 実質的な初回起動)にだけ自動適用する。既に自分の絞り込みを持っている
 * 利用者の状態を、起動のたびに勝手に上書きしないため。
 */
export function useAppFilterPresets(params: AppFilterPresetsParams): AppFilterPresetsResult {
  const {
    view,
    selectedProjectIds,
    priorityCeiling,
    issueTypes,
    labels,
    filterText,
    hideDone,
    stalledOnly,
    setView,
    setSelectedProjectIds,
    setPriorityCeiling,
    setIssueTypes,
    setLabels,
    setFilterText,
    setHideDone,
    setStalledOnly,
    boardFilterPresets,
  } = params;

  // 初回起動判定は localStorage が書き戻される前(= 最初のレンダー中)に確定させる。
  const [hadStoredFilterStateAtStartup] = useState(() => hasStoredBoardFilterState());
  const defaultPresetHandledRef = useRef(false);

  const boardFilterPresetState = useMemo<BoardFilterPresetState>(
    () => ({
      view,
      selectedProjectIds,
      priorityCeiling,
      issueTypes,
      labels,
      filterText,
      hideDone,
      stalledOnly,
    }),
    [
      view,
      selectedProjectIds,
      priorityCeiling,
      issueTypes,
      labels,
      filterText,
      hideDone,
      stalledOnly,
    ],
  );

  const handleApplyBoardFilterPreset = useCallback(
    (preset: BoardFilterPreset) => {
      setView(preset.view);
      setSelectedProjectIds(preset.selectedProjectIds);
      setPriorityCeiling(preset.priorityCeiling);
      setIssueTypes(preset.issueTypes);
      setLabels(preset.labels);
      setFilterText(preset.filterText);
      setHideDone(preset.hideDone);
      setStalledOnly(preset.stalledOnly);
    },
    [
      setView,
      setSelectedProjectIds,
      setPriorityCeiling,
      setIssueTypes,
      setLabels,
      setFilterText,
      setHideDone,
      setStalledOnly,
    ],
  );

  useEffect(() => {
    if (defaultPresetHandledRef.current) {
      return;
    }
    defaultPresetHandledRef.current = true;
    if (hadStoredFilterStateAtStartup) {
      return;
    }
    const defaultPreset = findDefaultBoardFilterPreset(boardFilterPresets);
    if (defaultPreset !== null) {
      handleApplyBoardFilterPreset(defaultPreset);
    }
  }, [boardFilterPresets, hadStoredFilterStateAtStartup, handleApplyBoardFilterPreset]);

  return { boardFilterPresetState, handleApplyBoardFilterPreset };
}
