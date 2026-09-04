import { describe, expect, it, vi } from 'vitest';
import {
  buildPaletteActions,
  filterPaletteActions,
  type PaletteAction,
} from './paletteActions';

function sampleActions(): PaletteAction[] {
  return buildPaletteActions({
    onViewChange: vi.fn(),
    onOpenChat: vi.fn(),
    onToggleHideDone: vi.fn(),
    hideDone: true,
    onToggleStalledOnly: vi.fn(),
    stalledOnly: false,
    onOpenSessionList: vi.fn(),
    onOpenHelp: vi.fn(),
    onRefresh: vi.fn(),
    chatAvailable: true,
  });
}

describe('filterPaletteActions', () => {
  it('returns all actions for an empty query', () => {
    const actions = sampleActions();
    expect(filterPaletteActions(actions, '')).toHaveLength(actions.length);
  });

  it('matches view labels and keywords', () => {
    const actions = sampleActions();
    const hits = filterPaletteActions(actions, '健全性');
    expect(hits.some((action) => action.id === 'view:hygiene')).toBe(true);
  });

  it('matches chat action by Japanese label', () => {
    const actions = sampleActions();
    const hits = filterPaletteActions(actions, 'チャット');
    expect(hits.some((action) => action.id === 'panel:chat')).toBe(true);
  });

  it('matches help action by Japanese query', () => {
    const actions = sampleActions();
    const hits = filterPaletteActions(actions, 'ヘルプ');
    expect(hits.some((action) => action.id === 'panel:help')).toBe(true);
  });

  it('matches help action by English query', () => {
    const actions = sampleActions();
    const hits = filterPaletteActions(actions, 'help');
    expect(hits.some((action) => action.id === 'panel:help')).toBe(true);
  });

  it('omits chat action when chat is unavailable', () => {
    const actions = buildPaletteActions({
      onViewChange: vi.fn(),
      onOpenChat: vi.fn(),
      onToggleHideDone: vi.fn(),
      hideDone: true,
      onToggleStalledOnly: vi.fn(),
      stalledOnly: false,
      onOpenSessionList: vi.fn(),
      onOpenHelp: vi.fn(),
      onRefresh: vi.fn(),
      chatAvailable: false,
    });
    expect(actions.some((action) => action.id === 'panel:chat')).toBe(false);
  });
});

describe('buildPaletteActions', () => {
  it('includes done lane toggle with current state detail', () => {
    const actions = buildPaletteActions({
      onViewChange: vi.fn(),
      onOpenChat: vi.fn(),
      onToggleHideDone: vi.fn(),
      hideDone: false,
      onToggleStalledOnly: vi.fn(),
      stalledOnly: true,
      onOpenSessionList: vi.fn(),
      onOpenHelp: vi.fn(),
      onRefresh: vi.fn(),
      chatAvailable: true,
    });

    const hideDone = actions.find((action) => action.id === 'board:toggle-hide-done');
    expect(hideDone?.detail).toBe('現在: 表示');

    const stalled = actions.find((action) => action.id === 'board:toggle-stalled-only');
    expect(stalled?.detail).toBe('現在: オン');
  });

  it('includes help panel action in パネル group', () => {
    const onOpenHelp = vi.fn();
    const actions = buildPaletteActions({
      onViewChange: vi.fn(),
      onOpenChat: vi.fn(),
      onToggleHideDone: vi.fn(),
      hideDone: true,
      onToggleStalledOnly: vi.fn(),
      stalledOnly: false,
      onOpenSessionList: vi.fn(),
      onOpenHelp,
      onRefresh: vi.fn(),
      chatAvailable: true,
    });

    const help = actions.find((action) => action.id === 'panel:help');
    expect(help).toBeDefined();
    expect(help?.label).toBe('ヘルプを開く');
    expect(help?.group).toBe('パネル');

    help?.onSelect();
    expect(onOpenHelp).toHaveBeenCalledOnce();
  });
});
