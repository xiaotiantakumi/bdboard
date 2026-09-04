import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '../api';
import { ProjectPicker, projectPickerLabel } from './ProjectPicker';

function project(id: string, name: string, incompleteTicketCount = 0): ProjectDto {
  return {
    id,
    name,
    rootPath: `/tmp/${id}`,
    prefixes: [id],
    sessionCount: 0,
    activeSessionCount: 0,
    incompleteTicketCount,
    sessions: [],
  };
}

const projects = [project('alpha', 'alpha'), project('beta', 'beta'), project('gamma', 'gamma')];

function renderPicker(
  overrides: Partial<{
    projects: ProjectDto[];
    selectedProjectIds: string[];
    onToggleProject: (projectId: string, checked: boolean) => void;
    onSelectAllProjects: () => void;
    onClearAllProjects: () => void;
    onSaveCombination: () => void;
  }> = {},
) {
  const handlers = {
    onToggleProject: overrides.onToggleProject ?? vi.fn(),
    onSelectAllProjects: overrides.onSelectAllProjects ?? vi.fn(),
    onClearAllProjects: overrides.onClearAllProjects ?? vi.fn(),
    onSaveCombination: overrides.onSaveCombination ?? vi.fn(),
  };
  render(
    <ProjectPicker
      projects={overrides.projects ?? projects}
      selectedProjectIds={overrides.selectedProjectIds ?? []}
      {...handlers}
    />,
  );
  return handlers;
}

describe('projectPickerLabel', () => {
  it('treats none-selected and all-selected as the same "all projects" state', () => {
    expect(projectPickerLabel(projects, [])).toBe('すべてのプロジェクト');
    expect(projectPickerLabel(projects, ['alpha', 'beta', 'gamma'])).toBe('すべてのプロジェクト');
  });

  it('collapses multiple selections into 他N件 so the button width is stable', () => {
    expect(projectPickerLabel(projects, ['beta'])).toBe('beta');
    expect(projectPickerLabel(projects, ['alpha', 'gamma'])).toBe('alpha 他1件');
  });
});

describe('ProjectPicker', () => {
  it('opens a popover instead of expanding inline', async () => {
    const user = userEvent.setup();
    renderPicker();

    const trigger = screen.getByRole('button', {
      name: 'プロジェクトの絞り込み: すべてのプロジェクト',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'プロジェクトの絞り込み' })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'プロジェクトの絞り込み' })).toBeInTheDocument();
  });

  it('toggles a project and reports the shown count', async () => {
    const user = userEvent.setup();
    const { onToggleProject } = renderPicker({ selectedProjectIds: ['alpha'] });

    await user.click(screen.getByRole('button', { name: 'プロジェクトの絞り込み: alpha' }));
    expect(screen.getByText('1 / 3 件を表示中')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'beta' }));
    expect(onToggleProject).toHaveBeenCalledWith('beta', true);

    await user.click(screen.getByRole('checkbox', { name: 'alpha' }));
    expect(onToggleProject).toHaveBeenCalledWith('alpha', false);
  });

  it('groups the selected projects above the rest', async () => {
    const user = userEvent.setup();
    renderPicker({ selectedProjectIds: ['gamma'] });

    await user.click(screen.getByRole('button', { name: 'プロジェクトの絞り込み: gamma' }));
    const rows = screen.getAllByRole('checkbox');
    expect(rows[0]).toHaveAccessibleName('gamma');
    expect(rows[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('選択中')).toBeInTheDocument();
    expect(screen.getByText('その他')).toBeInTheDocument();
  });

  it('filters the list with the search box', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(
      screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
    );
    await user.type(screen.getByLabelText('プロジェクトを検索'), 'ga');

    expect(screen.getByRole('checkbox', { name: 'gamma' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'alpha' })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('プロジェクトを検索'));
    await user.type(screen.getByLabelText('プロジェクトを検索'), 'zzz');
    expect(screen.getByText('該当するプロジェクトがありません')).toBeInTheDocument();
  });

  it('drops the search text when closed, so reopening shows the whole list', async () => {
    const user = userEvent.setup();
    renderPicker();

    const trigger = screen.getByRole('button', {
      name: 'プロジェクトの絞り込み: すべてのプロジェクト',
    });
    await user.click(trigger);
    await user.type(screen.getByLabelText('プロジェクトを検索'), 'zzz');
    expect(screen.getByText('該当するプロジェクトがありません')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(trigger);

    expect(screen.getByLabelText('プロジェクトを検索')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'alpha' })).toBeInTheDocument();
  });

  it('hides the search box when there are only a couple of projects', async () => {
    const user = userEvent.setup();
    renderPicker({ projects: projects.slice(0, 2) });

    await user.click(
      screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
    );
    expect(screen.queryByLabelText('プロジェクトを検索')).not.toBeInTheDocument();
  });

  it('exposes bulk select / clear', async () => {
    const user = userEvent.setup();
    const { onSelectAllProjects, onClearAllProjects } = renderPicker();

    await user.click(
      screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
    );
    await user.click(screen.getByRole('button', { name: 'すべて' }));
    await user.click(screen.getByRole('button', { name: '解除' }));

    expect(onSelectAllProjects).toHaveBeenCalledTimes(1);
    expect(onClearAllProjects).toHaveBeenCalledTimes(1);
  });

  it('closes and hands off to the preset control when saving the combination', async () => {
    const user = userEvent.setup();
    const { onSaveCombination } = renderPicker({ selectedProjectIds: ['alpha'] });

    await user.click(screen.getByRole('button', { name: 'プロジェクトの絞り込み: alpha' }));
    await user.click(screen.getByRole('button', { name: 'この組み合わせを保存' }));

    expect(onSaveCombination).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'プロジェクトの絞り込み' })).not.toBeInTheDocument();
  });

  it('focuses the search input when the popover opens', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(
      screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
    );

    expect(screen.getByLabelText('プロジェクトを検索')).toHaveFocus();
  });

  it('traps Tab focus within the popover (Shift+Tab wraps to the last focusable item)', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(
      screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
    );

    const searchInput = screen.getByLabelText('プロジェクトを検索');
    expect(searchInput).toHaveFocus();

    const saveButton = screen.getByRole('button', { name: 'この組み合わせを保存' });
    fireEvent.keyDown(searchInput, { key: 'Tab', shiftKey: true });
    expect(saveButton).toHaveFocus();

    fireEvent.keyDown(saveButton, { key: 'Tab' });
    expect(searchInput).toHaveFocus();
  });

  it('closes the popover and returns focus to the toggle button on Escape', async () => {
    const user = userEvent.setup();
    renderPicker();

    const toggleButton = screen.getByRole('button', {
      name: 'プロジェクトの絞り込み: すべてのプロジェクト',
    });
    await user.click(toggleButton);
    const dialog = screen.getByRole('dialog', { name: 'プロジェクトの絞り込み' });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'プロジェクトの絞り込み' })).not.toBeInTheDocument();
    expect(toggleButton).toHaveFocus();
  });

  it('shows incomplete ticket counts right-aligned on each row', async () => {
    const user = userEvent.setup();
    renderPicker({
      projects: [
        project('alpha', 'alpha', 18),
        project('beta', 'beta', 0),
        project('gamma', 'gamma', 11),
      ],
    });

    await user.click(
      screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
    );

    const alphaRow = screen.getByRole('checkbox', { name: 'alpha' });
    const betaRow = screen.getByRole('checkbox', { name: 'beta' });
    const gammaRow = screen.getByRole('checkbox', { name: 'gamma' });

    expect(alphaRow.querySelector('.project-picker-ticket-count')).toHaveTextContent('18');
    expect(betaRow.querySelector('.project-picker-ticket-count')).toHaveTextContent('0');
    expect(gammaRow.querySelector('.project-picker-ticket-count')).toHaveTextContent('11');
    expect(betaRow.querySelector('.project-picker-ticket-count')).toHaveClass(
      'project-picker-ticket-count-zero',
    );
    expect(alphaRow.querySelector('.project-picker-ticket-count')).not.toHaveClass(
      'project-picker-ticket-count-zero',
    );
  });
});

const POPOVER_VIEWPORT_GUTTER_RATIO = 0.02;
const POPOVER_VIEWPORT_GUTTER_MIN_PX = 12;

function gutterForViewport(viewportWidth: number): number {
  return Math.max(POPOVER_VIEWPORT_GUTTER_MIN_PX, viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO);
}

function stubClientWidth(width: number) {
  return vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
}

function stubBoundingRect(rect: Pick<DOMRect, 'left' | 'right'>) {
  const width = rect.right - rect.left;
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: 0,
    width,
    height: 0,
    top: 0,
    right: rect.right,
    bottom: 0,
    left: rect.left,
    toJSON: () => ({}),
  });
}

async function openPickerPopover() {
  const user = userEvent.setup();
  const view = render(
    <ProjectPicker
      projects={projects}
      selectedProjectIds={[]}
      onToggleProject={vi.fn()}
      onSelectAllProjects={vi.fn()}
      onClearAllProjects={vi.fn()}
      onSaveCombination={vi.fn()}
    />,
  );
  await user.click(
    screen.getByRole('button', { name: 'プロジェクトの絞り込み: すべてのプロジェクト' }),
  );
  return view;
}

describe('ProjectPicker popover viewport clamp (bdboard-oeh5)', () => {
  let clientWidthSpy: ReturnType<typeof stubClientWidth> | undefined;
  let rectSpy: ReturnType<typeof stubBoundingRect> | undefined;

  afterEach(() => {
    clientWidthSpy?.mockRestore();
    rectSpy?.mockRestore();
    clientWidthSpy = undefined;
    rectSpy = undefined;
  });

  it('shifts left when the right-aligned popover overflows the right edge at 320px', async () => {
    const viewportWidth = 320;
    clientWidthSpy = stubClientWidth(viewportWidth);
    // right:0 起点。実測に近いが右端はみ出しを確実にする値。
    rectSpy = stubBoundingRect({ left: 30, right: 315 });

    const { container } = await openPickerPopover();
    const popover = container.querySelector('.project-picker-popover');
    expect(popover).not.toBeNull();

    const shiftPx = Number.parseFloat(
      (popover as HTMLElement).style.getPropertyValue('--popover-shift-x'),
    );
    const gutter = gutterForViewport(viewportWidth);

    expect(shiftPx).toBeLessThan(0);
    expect(311 + shiftPx).toBeLessThanOrEqual(viewportWidth - gutter);
  });

  it('keeps --popover-shift-x at 0px when the popover already fits', async () => {
    clientWidthSpy = stubClientWidth(1280);
    rectSpy = stubBoundingRect({ left: 900, right: 1200 });

    const { container } = await openPickerPopover();
    const popover = container.querySelector('.project-picker-popover');
    expect(popover).not.toBeNull();
    expect((popover as HTMLElement).style.getPropertyValue('--popover-shift-x')).toBe('0px');
  });
});
