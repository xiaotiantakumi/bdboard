import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTypingTarget } from '../keyboardShortcuts';
import { KeyboardShortcutsPanel } from './KeyboardShortcutsPanel';

describe('isTypingTarget', () => {
  it('returns true for input, textarea, select, and contenteditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
  });

  it('returns false for non-typing elements', () => {
    const button = document.createElement('button');
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('KeyboardShortcutsPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists major keyboard shortcuts', () => {
    render(<KeyboardShortcutsPanel onClose={vi.fn()} />);

    expect(screen.getByText('j / ↓')).toBeInTheDocument();
    expect(screen.getByText('k / ↑')).toBeInTheDocument();
    expect(screen.getByText('h / ←')).toBeInTheDocument();
    expect(screen.getByText('l / →')).toBeInTheDocument();
    expect(screen.getByText('Enter / Space')).toBeInTheDocument();
    expect(screen.getByText('⌘/Ctrl + K')).toBeInTheDocument();
    expect(screen.getByText('Escape')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<KeyboardShortcutsPanel onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the overlay backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<KeyboardShortcutsPanel onClose={onClose} />);

    const overlay = container.querySelector('.shortcuts-help-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the panel content is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<KeyboardShortcutsPanel onClose={onClose} />);

    await user.click(screen.getByRole('heading', { name: 'キーボードショートカット' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes via the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<KeyboardShortcutsPanel onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
