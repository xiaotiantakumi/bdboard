import { usePersistedState } from './usePersistedState';
import {
  DEFAULT_TIPS_BANNER_DISMISSED,
  DEFAULT_VIEW,
  UI_STORAGE_KEYS,
  validateActivityWindowDays,
  validateBoardFilterPresets,
  validateBoolean,
  validateRecentTickets,
  validateStatsWeeks,
  validateString,
  validateStringArray,
  validateViewMode,
  type ActivityWindowDays,
  type BoardFilterPreset,
  type RecentTicketEntry,
  type StatsWeeks,
  type ViewMode,
} from '../uiPersistedState';

type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

export interface AppUiPreferences {
  view: ViewMode;
  setView: PersistedSetter<ViewMode>;
  selectedProjectIds: string[];
  setSelectedProjectIds: PersistedSetter<string[]>;
  lastChatProjectId: string;
  setLastChatProjectId: PersistedSetter<string>;
  boardFilterPresets: BoardFilterPreset[];
  setBoardFilterPresets: PersistedSetter<BoardFilterPreset[]>;
  activityWindowDays: ActivityWindowDays;
  setActivityWindowDays: PersistedSetter<ActivityWindowDays>;
  digestWindowDays: ActivityWindowDays;
  setDigestWindowDays: PersistedSetter<ActivityWindowDays>;
  statsWeeks: StatsWeeks;
  setStatsWeeks: PersistedSetter<StatsWeeks>;
  recentTickets: RecentTicketEntry[];
  setRecentTickets: PersistedSetter<RecentTicketEntry[]>;
  tipsBannerDismissed: boolean;
  setTipsBannerDismissed: PersistedSetter<boolean>;
}

/**
 * App.tsx 直下に並んでいた11個の usePersistedState 呼び出し
 * (view/selectedProjectIds/lastChatProjectId/boardFilterPresets/nextUpLimit/
 * nextUpShowEpics/activityWindowDays/digestWindowDays/statsWeeks/
 * recentTickets/tipsBannerDismissed) をひとまとめにするフック
 * (bdboard-62p4 第6段)。boardFilterState (優先度上限などボードのフィルタ7種)
 * は既に useBoardFilterState.ts に分かれているのでここには含めない。
 * bdboard-mkm1.3: Next Up ビュー削除に伴い nextUpLimit/nextUpShowEpics
 * (Next Up 専用の表示件数/epic表示トグル) は削除し、9個になった。
 *
 * localStorage のキー名 (UI_STORAGE_KEYS の該当エントリ)・既定値・
 * バリデータは元の App.tsx の呼び出しから1文字も変えていない
 * (useAppUiPreferences.test.ts でキー名と既定値の一致を検証)。
 *
 * hook 呼び出し順について: 元の App.tsx ではこの並びは
 * boardFilterState / nextUpBatchRun (queryClient +
 * useNextUpRunLoopController) と互い違いに並んでいたが、いずれも
 * usePersistedState (内部は useState + useEffect のみ、他の localStorage
 * キーや外部 I/O に依存しない) なので、互いの呼び出し順序を入れ替えても・
 * boardFilterState/nextUpBatchRun との相対位置を変えても観測可能な挙動は
 * 変わらない。このフック内部での呼び出し順序自体は元の宣言順 (view →
 * selectedProjectIds → lastChatProjectId → boardFilterPresets →
 * activityWindowDays → digestWindowDays → statsWeeks → recentTickets →
 * tipsBannerDismissed) を保っている。
 */
export function useAppUiPreferences(): AppUiPreferences {
  const [view, setView] = usePersistedState(UI_STORAGE_KEYS.view, DEFAULT_VIEW, validateViewMode);
  const [selectedProjectIds, setSelectedProjectIds] = usePersistedState(
    UI_STORAGE_KEYS.selectedProjectIds,
    [],
    validateStringArray,
  );
  const [lastChatProjectId, setLastChatProjectId] = usePersistedState(
    UI_STORAGE_KEYS.lastChatProjectId,
    '',
    validateString,
  );
  const [boardFilterPresets, setBoardFilterPresets] = usePersistedState(
    UI_STORAGE_KEYS.boardFilterPresets,
    [],
    validateBoardFilterPresets,
  );
  const [activityWindowDays, setActivityWindowDays] = usePersistedState(
    UI_STORAGE_KEYS.activityWindowDays,
    1,
    validateActivityWindowDays,
  );
  const [digestWindowDays, setDigestWindowDays] = usePersistedState(
    UI_STORAGE_KEYS.digestWindowDays,
    1,
    validateActivityWindowDays,
  );
  const [statsWeeks, setStatsWeeks] = usePersistedState(
    UI_STORAGE_KEYS.statsWeeks,
    8,
    validateStatsWeeks,
  );
  const [recentTickets, setRecentTickets] = usePersistedState(
    UI_STORAGE_KEYS.recentTickets,
    [],
    validateRecentTickets,
  );
  const [tipsBannerDismissed, setTipsBannerDismissed] = usePersistedState(
    UI_STORAGE_KEYS.tipsBannerDismissed,
    DEFAULT_TIPS_BANNER_DISMISSED,
    validateBoolean,
  );

  return {
    view,
    setView,
    selectedProjectIds,
    setSelectedProjectIds,
    lastChatProjectId,
    setLastChatProjectId,
    boardFilterPresets,
    setBoardFilterPresets,
    activityWindowDays,
    setActivityWindowDays,
    digestWindowDays,
    setDigestWindowDays,
    statsWeeks,
    setStatsWeeks,
    recentTickets,
    setRecentTickets,
    tipsBannerDismissed,
    setTipsBannerDismissed,
  };
}
