import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELP_SECTIONS } from '../helpContent';
import { HelpPanel } from './HelpPanel';

// jsdom は Element.prototype.scrollIntoView を実装していない (存在しないので vi.spyOn 不可)。
// HelpPanel.handleJumpToSection は requestAnimationFrame の中でこれを呼ぶため、
// 未定義のままだとテスト本体の終了後に TypeError が投げられ、全テスト pass でも
// vitest が非ゼロ終了する (PR #361 の CI 失敗)。
// グローバル (web/vitest.setup.ts) に置かないのは bdboard-vn1x の教訓 —
// no-op スタブが本番フォールバックをテストから到達不能にした。ここだけに閉じ込め、
// afterEach で必ず消す。
const scrollIntoViewMock = vi.fn();

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  // HelpPanel は UpdateNotice 経由で /api/update-check を引く (bdboard-70z.7)。
  // ここでの関心事はヘルプの表示なので、更新なしに固定してネットワークを断つ。
  fetchUpdateCheck: vi.fn(async () => ({ state: 'up-to-date', currentVersion: '1.0.0' })),
}));

function renderHelpPanel(props: { onClose: () => void }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HelpPanel onClose={props.onClose} />
    </QueryClientProvider>,
  );
}

function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** HELP_SECTIONS から、他の節の title/description/steps に現れない語を1つ選ぶ。 */
// userEvent.type() は `{` と `[` を「{Enter}」「[Space]」のようなキー記述の開始と解釈する。
// 打ち込む文字列は docs/help-content.json から実行時に取ってくる (bdboard-h4xs.16 minor-8) ため、
// 原本に将来これらの文字が入るとテストが不可解に壊れる。二重化がリテラル1文字のエスケープ。
// 原本を直した人が無関係な HelpPanel.test.tsx の失敗に出くわす、という minor-8 が塞いだはずの
// 結合をここで作り直さないための予防。
function escapeForUserEventType(text: string): string {
  return text.replace(/[{[]/g, '$&$&');
}

function findUniqueFilterKeyword(): { keyword: string; sectionId: string } {
  const sectionParts = HELP_SECTIONS.map((section) => ({
    id: section.id,
    parts: [section.title, section.description, ...section.steps],
  }));

  for (const { id, parts } of sectionParts) {
    for (const part of parts) {
      const normalizedPart = normalizeForSearch(part);
      if (normalizedPart.length < 3) {
        continue;
      }

      const matchingSectionIds = sectionParts
        .filter(({ parts: candidateParts }) =>
          candidateParts.some((candidate) =>
            normalizeForSearch(candidate).includes(normalizedPart),
          ),
        )
        .map(({ id: candidateId }) => candidateId);

      if (matchingSectionIds.length === 1 && matchingSectionIds[0] === id) {
        return { keyword: part, sectionId: id };
      }
    }
  }

  expect.fail(
    'Could not derive a filter keyword unique to a single HELP_SECTIONS entry',
  );
}

describe('HelpPanel', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
    });
  });

  afterEach(() => {
    delete (Element.prototype as Partial<Pick<Element, 'scrollIntoView'>>).scrollIntoView;
    scrollIntoViewMock.mockReset();
    vi.restoreAllMocks();
  });

  it('renders the help dialog and major feature sections', () => {
    renderHelpPanel({ onClose: vi.fn() });

    expect(screen.getByRole('dialog', { name: 'ヘルプ' })).toBeInTheDocument();
    expect(screen.getByText('bdboard バージョン', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByText(`v${__BDBOARD_VERSION__}`)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kanban（看板）' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '依存グラフ' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '統計' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'チャット' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'トンネル公開とQR' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '設定' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderHelpPanel({ onClose });

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the overlay backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = renderHelpPanel({ onClose });

    const overlay = container.querySelector('.help-panel-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the panel content is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderHelpPanel({ onClose });

    await user.click(screen.getByRole('heading', { name: 'Kanban（看板）' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes via the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderHelpPanel({ onClose });

    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a table of contents aligned with HELP_SECTIONS', () => {
    renderHelpPanel({ onClose: vi.fn() });

    const toc = screen.getByRole('navigation', { name: '目次' });
    const tocItems = within(toc).getAllByRole('button');

    expect(tocItems).toHaveLength(HELP_SECTIONS.length);
    expect(tocItems.map((item) => item.textContent)).toEqual(
      HELP_SECTIONS.map((section) => section.title),
    );
  });

  it('keeps all sections collapsed by default', () => {
    const { container } = renderHelpPanel({ onClose: vi.fn() });

    const sections = container.querySelectorAll('details.help-panel-section');
    expect(sections.length).toBe(HELP_SECTIONS.length);
    for (const section of sections) {
      expect(section).not.toHaveAttribute('open');
    }
  });

  it('opens a section and scrolls to it when its table-of-contents item is clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderHelpPanel({ onClose: vi.fn() });

    const targetSection = HELP_SECTIONS[0]!;
    await user.click(screen.getByRole('button', { name: targetSection.title }));

    const section = container
      .querySelector(`#help-section-${targetSection.id}`)
      ?.closest('details');
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute('open');

    // handleJumpToSection は requestAnimationFrame 越しに scrollIntoView を呼ぶ。
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(section);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' });

    const summary = section?.querySelector('summary');
    expect(summary).not.toBeNull();
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });
  });

  it('filters sections by keyword', async () => {
    const user = userEvent.setup();
    const { container } = renderHelpPanel({ onClose: vi.fn() });

    const { keyword, sectionId } = findUniqueFilterKeyword();
    const uniqueSection = HELP_SECTIONS.find((section) => section.id === sectionId);
    expect(uniqueSection).toBeDefined();

    await user.type(
      screen.getByRole('searchbox', { name: '絞り込み' }),
      escapeForUserEventType(keyword),
    );

    expect(screen.getByRole('navigation', { name: '目次' }).children).toHaveLength(
      1,
    );
    expect(
      screen.getByRole('heading', { name: uniqueSection!.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(`${HELP_SECTIONS.length}件中 1件`)).toBeInTheDocument();
    expect(
      container.querySelectorAll('details.help-panel-section'),
    ).toHaveLength(1);
  });

  it('closes all filtered sections after expanding all via the toggle button', async () => {
    const user = userEvent.setup();
    const { container } = renderHelpPanel({ onClose: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'すべて開く' }));
    expect(screen.getByRole('button', { name: 'すべて閉じる' })).toBeInTheDocument();

    const openSections = container.querySelectorAll('details.help-panel-section[open]');
    expect(openSections.length).toBe(HELP_SECTIONS.length);

    await user.click(screen.getByRole('button', { name: 'すべて閉じる' }));
    expect(screen.getByRole('button', { name: 'すべて開く' })).toBeInTheDocument();

    const sections = container.querySelectorAll('details.help-panel-section');
    for (const section of sections) {
      expect(section).not.toHaveAttribute('open');
    }
  });

  it('shows empty state and disables toggle when filter matches nothing', async () => {
    const user = userEvent.setup();
    renderHelpPanel({ onClose: vi.fn() });

    await user.type(
      screen.getByRole('searchbox', { name: '絞り込み' }),
      'zzzznonexistentkeyword12345',
    );

    expect(screen.getByText('該当するセクションがありません')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '目次' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'すべて開く' })).toBeDisabled();
    expect(screen.getByText(`${HELP_SECTIONS.length}件中 0件`)).toBeInTheDocument();
  });

  it('restores all sections after clearing the filter', async () => {
    const user = userEvent.setup();
    const { container } = renderHelpPanel({ onClose: vi.fn() });
    const { keyword } = findUniqueFilterKeyword();
    const searchbox = screen.getByRole('searchbox', { name: '絞り込み' });

    await user.type(searchbox, keyword);
    expect(screen.getByRole('navigation', { name: '目次' }).children).toHaveLength(1);
    expect(container.querySelectorAll('details.help-panel-section')).toHaveLength(1);

    await user.clear(searchbox);

    expect(screen.getByRole('navigation', { name: '目次' }).children).toHaveLength(
      HELP_SECTIONS.length,
    );
    expect(container.querySelectorAll('details.help-panel-section')).toHaveLength(
      HELP_SECTIONS.length,
    );
    expect(screen.getByText(`${HELP_SECTIONS.length}件中 ${HELP_SECTIONS.length}件`)).toBeInTheDocument();
  });

  it('matches section tokens when filter uses full-width alphanumerics', async () => {
    const user = userEvent.setup();
    renderHelpPanel({ onClose: vi.fn() });

    const pwaSection = HELP_SECTIONS.find((section) =>
      normalizeForSearch(section.title).includes('pwa'),
    );
    expect(pwaSection).toBeDefined();

    await user.type(screen.getByRole('searchbox', { name: '絞り込み' }), 'ＰＷＡ');

    expect(screen.getByRole('navigation', { name: '目次' }).children).toHaveLength(1);
    expect(
      screen.getByRole('heading', { name: pwaSection!.title }),
    ).toBeInTheDocument();
  });

  it('expands all sections via the toggle button', async () => {
    const user = userEvent.setup();
    const { container } = renderHelpPanel({ onClose: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'すべて開く' }));

    const sections = container.querySelectorAll('details.help-panel-section');
    expect(sections.length).toBe(HELP_SECTIONS.length);
    for (const section of sections) {
      expect(section).toHaveAttribute('open');
    }
  });
});
