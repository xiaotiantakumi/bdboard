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

// setter は usePersistedState が返す完全な形
// ((value: T | ((prev: T) => T)) => void) と揃える。現状の呼び出し側は
// 値を直接渡す形しか使っていないが、関数更新式(prev => …)も受け付けられる
// ようにしておくことで、次段(フィルタプリセット適用など)で必要になった
// ときに型を狭め直さずに済む (PR #649 レビュー指摘)。
type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

export interface BoardFilterState {
  priorityCeiling: PriorityCeilingChoice;
  setPriorityCeiling: PersistedSetter<PriorityCeilingChoice>;
  issueTypes: string[];
  setIssueTypes: PersistedSetter<string[]>;
  labels: string[];
  setLabels: PersistedSetter<string[]>;
  filterText: string;
  setFilterText: PersistedSetter<string>;
  hideDone: boolean;
  setHideDone: PersistedSetter<boolean>;
  stalledOnly: boolean;
  setStalledOnly: PersistedSetter<boolean>;
  collapsedLanes: Lane[];
  collapsedLanesSet: Set<Lane>;
  onToggleLaneCollapse: (lane: Lane) => void;
  filter: BoardFilter;
}

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
 * hook 呼び出し順について: 7つの usePersistedState 呼び出しは、App.tsx の
 * 元のブロックと同じ位置・同じ相対順序 (hideDone → stalledOnly →
 * collapsedLanes → priorityCeiling → issueTypes → labels → filterText) で
 * このフックの先頭から呼ぶため、App.tsx 全体で見てもこれら7つの呼び出し順は
 * 変わらない。一方 collapsedLanesSet/onToggleLaneCollapse/filter の
 * useMemo/useCallback は、元は多数のクエリ系 hook の後(旧 boardFilter 定義
 * 位置)にあったのをこのフックの末尾に含めたため、App.tsx 全体で見た呼び出し
 * 位置は前倒しになる。ただしこの3つはいずれも useEffect を含まない純粋な
 * 計算(state 更新や外部 I/O を行わない)なので、他の hook の実行順序に
 * 依存する副作用は無く、観測可能な挙動は変わらない。詳細は PR #649 参照。
 */
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
