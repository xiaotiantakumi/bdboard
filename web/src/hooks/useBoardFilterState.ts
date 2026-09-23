import { useCallback, useMemo } from 'react';
import type { Lane } from '../api';
import type { BoardFilter } from '../boardFilter';
import {
  DEFAULT_HIDE_DONE,
  DEFAULT_STALLED_ONLY,
  priorityCeilingValue,
  type PriorityCeilingChoice,
  UI_STORAGE_KEYS,
  validateBoolean,
  validateIssueTypeArray,
  validateLaneArray,
  validatePriorityCeiling,
  validateString,
  validateStringArray,
} from '../uiPersistedState';
import { usePersistedState } from './usePersistedState';

/**
 * ボードのフィルタ/表示切り替え状態(優先度上限・issueType・ラベル・自由文字列・
 * doneレーン非表示・滞留のみ・レーン折りたたみ)をひとまとめにするフック
 * (bdboard-62p4)。
 *
 * App.tsx の候補2「ビュー切替本体」は state 依存が広すぎて単純な
 * 1コンポーネント抽出だと ≤12 props (soft guidance) を大きく超える
 * (bdboard-62p4 チケット本文の分析)。まずこのフックで App.tsx 内の関連
 * useState/useMemo/useCallback をひとつにまとめ、次段の view 別レンダラー
 * 抽出で渡す props をこのオブジェクト1つに畳めるようにする。
 *
 * 7つの usePersistedState 呼び出しは、App.tsx で元々連続して呼ばれていた
 * (hideDone → stalledOnly → collapsedLanes → priorityCeiling → issueTypes →
 * labels → filterText) のと同じ相対順序で呼ぶ。フック呼び出し全体の位置は
 * App.tsx 側で他の hook との相対順序が変わるが、動かす対象はどれも副作用が
 * usePersistedState 内部の storage イベントリスナー(key ごとに独立)のみで、
 * 他の副作用と相互依存していないため観測可能な挙動は変わらない
 * (collapsedLanesSet/onToggleLaneCollapse/filter は useMemo/useCallback で
 * 副作用を持たない純粋な計算)。詳細は PR 本文参照。
 */
export interface BoardFilterState {
  priorityCeiling: PriorityCeilingChoice;
  setPriorityCeiling: (value: PriorityCeilingChoice) => void;
  issueTypes: string[];
  setIssueTypes: (value: string[]) => void;
  labels: string[];
  setLabels: (value: string[]) => void;
  filterText: string;
  setFilterText: (value: string) => void;
  hideDone: boolean;
  setHideDone: (value: boolean | ((prev: boolean) => boolean)) => void;
  stalledOnly: boolean;
  setStalledOnly: (value: boolean | ((prev: boolean) => boolean)) => void;
  collapsedLanes: Lane[];
  collapsedLanesSet: Set<Lane>;
  onToggleLaneCollapse: (lane: Lane) => void;
  filter: BoardFilter;
}

export function useBoardFilterState(): BoardFilterState {
  const [hideDone, setHideDone] = usePersistedState(
    UI_STORAGE_KEYS.hideDone,
    DEFAULT_HIDE_DONE,
    validateBoolean,
  );
  const [stalledOnly, setStalledOnly] = usePersistedState(
    UI_STORAGE_KEYS.stalledOnly,
    DEFAULT_STALLED_ONLY,
    validateBoolean,
  );
  const [collapsedLanes, setCollapsedLanes] = usePersistedState(
    UI_STORAGE_KEYS.collapsedLanes,
    [],
    validateLaneArray,
  );
  const [priorityCeiling, setPriorityCeiling] = usePersistedState(
    UI_STORAGE_KEYS.boardPriorityCeiling,
    'all',
    validatePriorityCeiling,
  );
  const [issueTypes, setIssueTypes] = usePersistedState(
    UI_STORAGE_KEYS.boardIssueTypes,
    [],
    validateIssueTypeArray,
  );
  const [labels, setLabels] = usePersistedState(
    UI_STORAGE_KEYS.boardLabels,
    [],
    validateStringArray,
  );
  const [filterText, setFilterText] = usePersistedState(
    UI_STORAGE_KEYS.boardFilterText,
    '',
    validateString,
  );

  const collapsedLanesSet = useMemo(
    () => new Set<Lane>(collapsedLanes),
    [collapsedLanes],
  );

  const onToggleLaneCollapse = useCallback(
    (lane: Lane) => {
      setCollapsedLanes((prev) =>
        prev.includes(lane) ? prev.filter((item) => item !== lane) : [...prev, lane],
      );
    },
    [setCollapsedLanes],
  );

  const filter = useMemo<BoardFilter>(
    () => ({
      priorityCeiling: priorityCeilingValue(priorityCeiling),
      issueTypes,
      labels,
      text: filterText,
    }),
    [priorityCeiling, issueTypes, labels, filterText],
  );

  return {
    priorityCeiling,
    setPriorityCeiling,
    issueTypes,
    setIssueTypes,
    labels,
    setLabels,
    filterText,
    setFilterText,
    hideDone,
    setHideDone,
    stalledOnly,
    setStalledOnly,
    collapsedLanes,
    collapsedLanesSet,
    onToggleLaneCollapse,
    filter,
  };
}
