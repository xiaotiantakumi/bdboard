import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useTicketFormReset,
  type UseTicketFormResetParams,
} from './useTicketFormReset';

// このテストで固定する不変条件は2つ:
// 1. ticketId/projectRootPath が実際に変わったときだけリセットが走ること。
//    これが崩れると、パネルを開いたまま起きる無関係な再レンダーのたびに、
//    入力中の下書きが消えてしまう。
// 2. 9つの reset が元の resetFormState と同じ順序で呼ばれること。
//    各 reset は互いに独立した state 更新で、呼び出し順序そのものが機能的に
//    必須というわけではない。ここで順序を固定するのは、move-only で抽出した
//    元のコードをそのまま裏付け、将来の変更で意図せず順序が変わったときに
//    気付けるようにするため。
// TicketDetailPanel.tsx から抽出する前の resetFormState + useEffect の
// 挙動をそのまま検証する (bdboard-sso1.5)。パネル本体の ticketId prop 変化で
// 実際にこのフックが正しく配線されていることは
// TicketDetailPanel.test.tsx の「clears an in-progress, unsaved title edit
// when the panel switches to a different ticket」で確認する
// (UseTicketFormResetParams は全フィールドが同じ `() => void` 型なので、
// ここでのモック関数テストだけでは配線ミス — 例えば resetTitleEditing に
// resetDescriptionEditing を渡す間違い — を検出できないため)。

function makeParams(
  overrides: Partial<UseTicketFormResetParams> = {},
): UseTicketFormResetParams {
  return {
    ticketId: 'bd-1',
    projectRootPath: '/repo',
    clearCopyDisplay: vi.fn(),
    resetDecision: vi.fn(),
    resetQuickActions: vi.fn(),
    resetComment: vi.fn(),
    resetDependencies: vi.fn(),
    resetLabelInput: vi.fn(),
    resetTitleEditing: vi.fn(),
    resetDescriptionEditing: vi.fn(),
    resetSessionLink: vi.fn(),
    ...overrides,
  };
}

describe('useTicketFormReset', () => {
  it('resets every section once on mount, passing clearSubmittedDecision: true to resetDecision', () => {
    const params = makeParams();
    renderHook(() => useTicketFormReset(params));

    expect(params.clearCopyDisplay).toHaveBeenCalledTimes(1);
    expect(params.resetDecision).toHaveBeenCalledTimes(1);
    expect(params.resetDecision).toHaveBeenCalledWith({
      clearSubmittedDecision: true,
    });
    expect(params.resetQuickActions).toHaveBeenCalledTimes(1);
    expect(params.resetComment).toHaveBeenCalledTimes(1);
    expect(params.resetDependencies).toHaveBeenCalledTimes(1);
    expect(params.resetLabelInput).toHaveBeenCalledTimes(1);
    expect(params.resetTitleEditing).toHaveBeenCalledTimes(1);
    expect(params.resetDescriptionEditing).toHaveBeenCalledTimes(1);
    expect(params.resetSessionLink).toHaveBeenCalledTimes(1);
  });

  it('calls the resets in the original resetFormState order', () => {
    const order: string[] = [];
    const params = makeParams({
      clearCopyDisplay: vi.fn(() => order.push('clearCopyDisplay')),
      resetDecision: vi.fn(() => order.push('resetDecision')),
      resetQuickActions: vi.fn(() => order.push('resetQuickActions')),
      resetComment: vi.fn(() => order.push('resetComment')),
      resetDependencies: vi.fn(() => order.push('resetDependencies')),
      resetLabelInput: vi.fn(() => order.push('resetLabelInput')),
      resetTitleEditing: vi.fn(() => order.push('resetTitleEditing')),
      resetDescriptionEditing: vi.fn(() =>
        order.push('resetDescriptionEditing'),
      ),
      resetSessionLink: vi.fn(() => order.push('resetSessionLink')),
    });

    renderHook(() => useTicketFormReset(params));

    expect(order).toEqual([
      'clearCopyDisplay',
      'resetDecision',
      'resetQuickActions',
      'resetComment',
      'resetDependencies',
      'resetLabelInput',
      'resetTitleEditing',
      'resetDescriptionEditing',
      'resetSessionLink',
    ]);
  });

  it('does not re-run the reset on a re-render with unchanged ticketId/projectRootPath and stable callbacks', () => {
    const params = makeParams();
    const { rerender } = renderHook(() => useTicketFormReset(params));

    expect(params.resetComment).toHaveBeenCalledTimes(1);

    rerender();

    expect(params.resetComment).toHaveBeenCalledTimes(1);
  });

  it('re-runs the reset when ticketId changes', () => {
    const params = makeParams({ ticketId: 'bd-1' });
    const { rerender } = renderHook(
      (props: UseTicketFormResetParams) => useTicketFormReset(props),
      { initialProps: params },
    );

    expect(params.resetSessionLink).toHaveBeenCalledTimes(1);

    rerender({ ...params, ticketId: 'bd-2' });

    expect(params.resetSessionLink).toHaveBeenCalledTimes(2);
  });

  it('re-runs the reset when only projectRootPath changes (ticketId unchanged)', () => {
    const params = makeParams({ projectRootPath: '/repo-a' });
    const { rerender } = renderHook(
      (props: UseTicketFormResetParams) => useTicketFormReset(props),
      { initialProps: params },
    );

    expect(params.resetLabelInput).toHaveBeenCalledTimes(1);

    rerender({ ...params, projectRootPath: '/repo-b' });

    expect(params.resetLabelInput).toHaveBeenCalledTimes(2);
  });

  it('re-runs the reset when projectRootPath goes from undefined to a value (first data arrival)', () => {
    // 実際のマウント直後によく起きる遷移: data がまだ無い間は
    // projectRootPath === undefined、ticket が届いた瞬間に文字列へ変わる
    // (TicketDetailPanel.tsx の `projectRootPath = data === undefined ? undefined
    // : projectRootPaths.get(data.projectId)` 参照)。'/repo-a' → '/repo-b' の
    // ケースとは違う経路 (undefined から実値への遷移) も deps 配列に
    // 正しく反応することを別途確認する。
    const params = makeParams({ projectRootPath: undefined });
    const { rerender } = renderHook(
      (props: UseTicketFormResetParams) => useTicketFormReset(props),
      { initialProps: params },
    );

    expect(params.resetDependencies).toHaveBeenCalledTimes(1);

    rerender({ ...params, projectRootPath: '/repo' });

    expect(params.resetDependencies).toHaveBeenCalledTimes(2);
  });
});

// 型レベルの保証: UseTicketFormResetParams に agentRun 由来のフィールド
// (例: resetAgentRun) が追加されたら、この行で `npm run build:web` の
// tsc --noEmit がコンパイルエラーとして検出する。PR-L の effect 順序
// リグレッション(このフックが agentRun の reset/復元に触れると再発するクラスの
// バグ)の再発防止。実行時アサーションではなく型だけの仕掛けなので、
// vitest 上は何も検証しない(失敗するとすればビルド時)。
type AgentRunFieldMustNotExist =
  'resetAgentRun' extends keyof UseTicketFormResetParams ? never : true;
// eslint の unused-vars を避けるためだけの最小参照。実行時の意味は無い。
const _agentRunFieldGuard: AgentRunFieldMustNotExist = true;
void _agentRunFieldGuard;
