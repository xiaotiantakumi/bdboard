import { type UseQueryResult } from '@tanstack/react-query';
import { type BoardCardDto, type BoardViewDto, type PrBadgeDto } from '../../api';
import { type BoardFilterState } from '../../hooks/useBoardFilterState';
import { type ViewMode } from '../../uiPersistedState';
import { type WipLimitsOverrides } from '../../wip-limits';
import { VIEW_LABELS } from '../../paletteActions';
import { ErrorBoundary } from '../ErrorBoundary';
import { SettingsPanel } from '../SettingsPanel';
import { AppBoardViewSwitch } from './AppBoardViewSwitch';

/**
 * bdboard-62p4 候補2「ビュー切替本体」。App.tsx の
 * `<ErrorBoundary key={view} …>` 配下(旧 L862-1026)を丸ごと移した表示専用
 * コンポーネント。state・effect・react-query の呼び出しは一切ここに移さず
 * App.tsx 側に残す(App.tsx はこのコンポーネントに props を渡すだけ)。
 *
 * props はこの塊が依存する state/派生値が25個を超えるため(チケット本文の
 * 分析どおり)、関心ごとにオブジェクトへまとめている: `filterState` は
 * useBoardFilterState() の戻り値をそのまま、`board`/`boardMeta` はボード
 * 表示に必要なクエリ結果と派生 Map/Set、`nextUp` は各ビュー固有の
 * ウィンドウ幅・limit 状態。JSX・分岐条件・渡す値は元の App.tsx から一切
 * 変えていない(変数参照をグループ化した prop 経由の参照に置き換えただけ)。
 * bdboard-mkm1.3: Next Up ビュー削除に伴い、`nextUp` は一括実行ループの
 * コントローラ(batchRun。一括操作バーが使う)だけを残した。
 *
 * ボード系ビュー(split)の JSX は ESLint の200行上限のため
 * ./AppBoardViewSwitch.tsx へさらに分けた。ここは ErrorBoundary と
 * ボード以外のビュー(settings)
 * の出し分けだけを持つ。
 */
export interface AppViewContentProps {
  view: ViewMode;
  filterState: BoardFilterState;
  epicFilterId: string | undefined;
  onClearEpicFilter: () => void;
  board: {
    query: Pick<UseQueryResult<BoardViewDto>, 'data' | 'isLoading' | 'error'>;
    cardsById: Map<string, BoardCardDto>;
    availableLabels: string[] | undefined;
  };
  boardMeta: {
    projectNames: Map<string, string>;
    projectActiveSessions: Map<string, number>;
    projectRootPaths: Map<string, string>;
    pendingDecisionIds: ReadonlySet<string>;
    prLinksById: ReadonlyMap<string, PrBadgeDto>;
    wipLimitsOverrides: WipLimitsOverrides;
    selectedProjectIds: readonly string[];
    selectedProjectIdsJoined: string;
  };
  onCardClick: (ticketId: string) => void;
}

export function AppViewContent({
  view,
  filterState,
  epicFilterId,
  onClearEpicFilter,
  board,
  boardMeta,
  onCardClick,
}: AppViewContentProps) {
  return (
    // view をキーにして、別ビューへ切り替えたら壊れた状態を持ち越さない。
    <ErrorBoundary key={view} label={VIEW_LABELS[view]}>
      <AppBoardViewSwitch
        view={view}
        filterState={filterState}
        epicFilterId={epicFilterId}
        onClearEpicFilter={onClearEpicFilter}
        board={board}
        boardMeta={{
          projectNames: boardMeta.projectNames,
          projectActiveSessions: boardMeta.projectActiveSessions,
          pendingDecisionIds: boardMeta.pendingDecisionIds,
          prLinksById: boardMeta.prLinksById,
          wipLimitsOverrides: boardMeta.wipLimitsOverrides,
          selectedProjectIdsJoined: boardMeta.selectedProjectIdsJoined,
        }}
        onCardClick={onCardClick}
      />
      {view === 'settings' && <SettingsPanel />}
    </ErrorBoundary>
  );
}
