import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoardFilterBar,
  countActiveFilters,
  isFilterActive,
} from './BoardFilterBar';

function setLayoutWidth(px: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: px,
  });
}

function restoreLayoutWidth() {
  Reflect.deleteProperty(document.documentElement, 'clientWidth');
}

function renderBar(
  overrides: Partial<{
    priorityCeiling: 'all' | '0' | '1' | '2' | '3' | '4';
    issueTypes: string[];
    labels: string[];
    availableLabels: string[];
    filterText: string;
    onPriorityCeilingChange: (choice: 'all' | '0' | '1' | '2' | '3' | '4') => void;
    onIssueTypesChange: (types: string[]) => void;
    onLabelsChange: (labels: string[]) => void;
    onFilterTextChange: (text: string) => void;
  }> = {},
) {
  const onPriorityCeilingChange = overrides.onPriorityCeilingChange ?? vi.fn();
  const onIssueTypesChange = overrides.onIssueTypesChange ?? vi.fn();
  const onLabelsChange = overrides.onLabelsChange ?? vi.fn();
  const onFilterTextChange = overrides.onFilterTextChange ?? vi.fn();

  render(
    <BoardFilterBar
      priorityCeiling={overrides.priorityCeiling ?? 'all'}
      onPriorityCeilingChange={onPriorityCeilingChange}
      issueTypes={overrides.issueTypes ?? []}
      onIssueTypesChange={onIssueTypesChange}
      labels={overrides.labels ?? []}
      onLabelsChange={onLabelsChange}
      availableLabels={overrides.availableLabels ?? ['human', 'needs-review']}
      filterText={overrides.filterText ?? ''}
      onFilterTextChange={onFilterTextChange}
    />,
  );

  return {
    onPriorityCeilingChange,
    onIssueTypesChange,
    onLabelsChange,
    onFilterTextChange,
  };
}

describe('BoardFilterBar', () => {
  describe('countActiveFilters', () => {
    it('counts each active constraint', () => {
      expect(
        countActiveFilters('all', [], [], ''),
      ).toBe(0);
      expect(
        countActiveFilters('2', ['bug', 'task'], ['human'], 'alpha'),
      ).toBe(5);
      expect(
        isFilterActive('all', [], [], ''),
      ).toBe(false);
      expect(
        isFilterActive('1', [], [], ''),
      ).toBe(true);
    });
  });

  describe('mobile collapse', () => {
    beforeEach(() => {
      setLayoutWidth(375);
    });

    afterEach(() => {
      restoreLayoutWidth();
    });

    it('starts collapsed and hides filter controls until toggled', async () => {
      const user = userEvent.setup();
      renderBar();

      expect(screen.getByRole('button', { name: '絞り込み' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(screen.queryByLabelText('優先度上限')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '絞り込み' }));
      expect(screen.getByRole('button', { name: '絞り込み' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(screen.getByLabelText('優先度上限')).toBeInTheDocument();
    });

    it('keeps the toggle text concise while exposing active filter count to assistive tech', () => {
      renderBar({
        priorityCeiling: '1',
        issueTypes: ['bug'],
        labels: ['human'],
        filterText: 'alpha',
      });

      expect(screen.getByRole('button', { name: '絞り込み (4件適用中)' })).toBeInTheDocument();
      expect(document.querySelector('.board-filter-toggle-label')).toHaveTextContent(
        /^絞り込み$/,
      );
      expect(document.querySelector('.board-filter-active-badge')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
      expect(document.querySelector('.board-filter-active-badge')).toHaveTextContent(/^4$/);
    });

    describe('quick clear in the collapsed toggle row (bdboard-jch5)', () => {
      // 名前ではなくクラスで引く。アクセシブル名はパネル側の解除ボタンと同じ
      // 「フィルタ解除」に揃えてあるため、名前だけでは両者を区別できない
      // (排他レンダリングなので実画面では衝突しないが、テストの意図は
      //  「トグル行側のボタン」に固定したい)。
      const quickClear = () =>
        document.querySelector<HTMLButtonElement>('.board-filter-toggle-clear');

      it('shows a quick clear button next to the toggle when collapsed with active filters', () => {
        renderBar({ priorityCeiling: '1' });

        expect(quickClear()).toBeInTheDocument();
      });

      it('keeps the toggle the only button whose name starts with 絞り込み', () => {
        // アクセシブル名を「絞り込みを解除」等にすると、トグル本体
        // 「絞り込み (N件適用中)」の接頭辞拡張になり、e2e 4本
        // (board-filter-breakpoint / board-filter-mobile-reach /
        //  mobile-input-font-size / fixtures/mobile-chrome-helpers の
        //  assertBoardFilterBarCollapsed) が使う
        // getByRole('button', { name: /^絞り込み/ }) が2要素に当たって
        // strict mode violation になる。この不変条件を単体側で固定する
        // (bdboard-jch5 レビュー MAJOR-1)。
        renderBar({ priorityCeiling: '1' });

        expect(quickClear()).toHaveAttribute('aria-label', 'フィルタ解除');
        expect(screen.getAllByRole('button', { name: /^絞り込み/ })).toHaveLength(1);
      });

      it('hides the quick clear button when there are no active filters', () => {
        renderBar();

        expect(quickClear()).not.toBeInTheDocument();
      });

      it('hides the quick clear button once the panel is expanded (no duplicate with the panel clear button)', async () => {
        const user = userEvent.setup();
        renderBar({ priorityCeiling: '1' });

        await user.click(screen.getByRole('button', { name: '絞り込み (1件適用中)' }));

        expect(quickClear()).not.toBeInTheDocument();
        // The panel's own clear button takes over instead.
        expect(
          screen.getByRole('button', { name: 'フィルタ解除' }),
        ).toBeInTheDocument();
      });

      it('resets all filter values when the quick clear button is pressed', async () => {
        const user = userEvent.setup();
        const onPriorityCeilingChange = vi.fn();
        const onIssueTypesChange = vi.fn();
        const onLabelsChange = vi.fn();
        const onFilterTextChange = vi.fn();

        renderBar({
          priorityCeiling: '1',
          issueTypes: ['bug'],
          labels: ['human'],
          filterText: 'alpha',
          onPriorityCeilingChange,
          onIssueTypesChange,
          onLabelsChange,
          onFilterTextChange,
        });

        await user.click(quickClear()!);

        expect(onPriorityCeilingChange).toHaveBeenCalledWith('all');
        expect(onIssueTypesChange).toHaveBeenCalledWith([]);
        expect(onLabelsChange).toHaveBeenCalledWith([]);
        expect(onFilterTextChange).toHaveBeenCalledWith('');
      });

      it('moves focus back to the toggle after the quick clear is pressed', async () => {
        // 実画面では押した瞬間に filterActive が false になってこのボタン自身が
        // unmount されるため、放っておくとフォーカスが body へ落ちてキーボード
        // 利用者が文脈を失う。トグル本体へ戻していることを固定する
        // (bdboard-jch5 レビュー MINOR-3)。
        const user = userEvent.setup();
        renderBar({ priorityCeiling: '1' });

        await user.click(quickClear()!);

        expect(screen.getByRole('button', { name: /^絞り込み/ })).toHaveFocus();
      });
    });
  });

  it('never shows the mobile quick clear button on desktop widths', () => {
    // At desktop widths isMobile is false, so the toggle row (and with it the
    // quick clear button) is not rendered at all — only the panel's own clear
    // button can appear.
    // 幅は jsdom の既定値に頼らず明示する。既定は 1024 だが、これはテストの前提
    // ではなく jsdom の実装詳細で、変わればこのテストは黙って意味を失う
    // (bdboard-jch5 レビュー NIT-7)。
    setLayoutWidth(1280);
    try {
      renderBar({ priorityCeiling: '1' });

      expect(document.querySelector('.board-filter-toggle-clear')).not.toBeInTheDocument();
      expect(document.querySelector('.board-filter-toggle-row')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'フィルタ解除' })).toBeInTheDocument();
    } finally {
      restoreLayoutWidth();
    }
  });

  it('calls onPriorityCeilingChange when select changes', () => {
    const { onPriorityCeilingChange } = renderBar();

    fireEvent.change(screen.getByLabelText('優先度上限'), {
      target: { value: '2' },
    });

    expect(onPriorityCeilingChange).toHaveBeenCalledWith('2');
  });

  it('toggles issue type chips on and off', async () => {
    const user = userEvent.setup();
    const onIssueTypesChange = vi.fn();

    const { rerender } = render(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={onIssueTypesChange}
        labels={[]}
        onLabelsChange={vi.fn()}
        availableLabels={['human']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'bug' }));
    expect(onIssueTypesChange).toHaveBeenCalledWith(['bug']);

    rerender(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={['bug']}
        onIssueTypesChange={onIssueTypesChange}
        labels={[]}
        onLabelsChange={vi.fn()}
        availableLabels={['human']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'bug' }));
    expect(onIssueTypesChange).toHaveBeenLastCalledWith([]);
  });

  it('toggles label chips on and off', async () => {
    const user = userEvent.setup();
    const onLabelsChange = vi.fn();

    const { rerender } = render(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={vi.fn()}
        labels={[]}
        onLabelsChange={onLabelsChange}
        availableLabels={['human', 'needs-review']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'human' }));
    expect(onLabelsChange).toHaveBeenCalledWith(['human']);

    rerender(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={vi.fn()}
        labels={['human']}
        onLabelsChange={onLabelsChange}
        availableLabels={['human', 'needs-review']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'human' }));
    expect(onLabelsChange).toHaveBeenLastCalledWith([]);
  });

  it('hides label section when the label union is empty', () => {
    renderBar({ availableLabels: [] });

    expect(screen.queryByRole('button', { name: 'human' })).not.toBeInTheDocument();
  });

  it('renders the label section when only a selected-but-unavailable label remains', () => {
    // Pins the `labelOptions.length > 0` guard itself: with availableLabels empty,
    // reverting the guard to availableLabels.length hides the whole group, which is
    // exactly the bdboard-we44 repro (badge counts 1, no chip to unpress).
    renderBar({ availableLabels: [], labels: ['archived'] });

    expect(screen.getByRole('button', { name: 'archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps selected labels visible when they are no longer available', async () => {
    const user = userEvent.setup();
    const onLabelsChange = vi.fn();
    const { rerender } = render(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={vi.fn()}
        labels={['archived']}
        onLabelsChange={onLabelsChange}
        availableLabels={['human']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'archived' }));
    expect(onLabelsChange).toHaveBeenCalledWith([]);

    rerender(
      <BoardFilterBar
        priorityCeiling="all"
        onPriorityCeilingChange={vi.fn()}
        issueTypes={[]}
        onIssueTypesChange={vi.fn()}
        labels={[]}
        onLabelsChange={onLabelsChange}
        availableLabels={['human']}
        filterText=""
        onFilterTextChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'archived' })).not.toBeInTheDocument();
  });

  it('sorts the label union with compareStrings order', () => {
    const availableLabels = ['a'];
    const labels = ['Z'];
    renderBar({ availableLabels, labels });

    const renderedLabels = screen
      .getAllByRole('button', { name: /^(Z|a)$/ })
      .map((button) => button.textContent);

    // Literal, not recomputed with compareStrings: this must fail if compareStrings
    // itself regresses. 'Z' (U+005A) sorts before 'a' (U+0061) in code-unit order,
    // whereas localeCompare would give ['a', 'Z'].
    expect(renderedLabels).toEqual(['Z', 'a']);
  });

  it('marks selected issue type chips as pressed', () => {
    renderBar({ issueTypes: ['feature', 'task'] });

    expect(screen.getByRole('button', { name: 'feature' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'bug' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('calls onFilterTextChange when text is entered', () => {
    const { onFilterTextChange } = renderBar();

    fireEvent.change(screen.getByRole('searchbox', { name: 'チケットの絞り込み' }), {
      target: { value: 'alpha' },
    });

    expect(onFilterTextChange).toHaveBeenCalledWith('alpha');
  });

  it('hides clear button when filter is inactive', () => {
    renderBar();

    expect(
      screen.queryByRole('button', { name: 'フィルタ解除' }),
    ).not.toBeInTheDocument();
  });

  it('shows clear button when filter is active and resets all values', async () => {
    const user = userEvent.setup();
    const onPriorityCeilingChange = vi.fn();
    const onIssueTypesChange = vi.fn();
    const onLabelsChange = vi.fn();
    const onFilterTextChange = vi.fn();

    renderBar({
      priorityCeiling: '1',
      issueTypes: ['bug'],
      labels: ['human'],
      filterText: 'alpha',
      onPriorityCeilingChange,
      onIssueTypesChange,
      onLabelsChange,
      onFilterTextChange,
    });

    await user.click(screen.getByRole('button', { name: 'フィルタ解除' }));

    expect(onPriorityCeilingChange).toHaveBeenCalledWith('all');
    expect(onIssueTypesChange).toHaveBeenCalledWith([]);
    expect(onLabelsChange).toHaveBeenCalledWith([]);
    expect(onFilterTextChange).toHaveBeenCalledWith('');
  });
});
