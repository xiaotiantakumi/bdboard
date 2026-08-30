import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
