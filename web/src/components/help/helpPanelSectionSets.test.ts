import { describe, expect, it } from 'vitest';
import type { HelpSection } from '../../helpContent';
import {
  addAllToSet,
  closeSection,
  openSection,
  removeAllFromSet,
} from './helpPanelSectionSets';

/**
 * bdboard-sso1.67: useHelpPanelFilter.ts から切り出した純ヘルパーの単体テスト。
 * これらは分割前に handleSectionToggle/handleToggleAll/handleJumpToSection の
 * setState 更新関数の中に書かれていた Set 操作をそのまま関数化したもの。
 * 参照同一性 (内容が変わらない場合は同じ Set を返す) は useHelpPanelSectionActions
 * 側の useCallback の再レンダー抑止にとって重要な不変条件なので、ここで固定する。
 */

const sections: readonly HelpSection[] = [
  { id: 'a', title: 'A', description: '', steps: [] },
  { id: 'b', title: 'B', description: '', steps: [] },
  { id: 'c', title: 'C', description: '', steps: [] },
];

describe('openSection', () => {
  it('adds the id when absent', () => {
    const previous = new Set(['a']);
    const next = openSection(previous, 'b');
    expect(next).toEqual(new Set(['a', 'b']));
  });

  it('returns the same reference when the id is already present', () => {
    const previous = new Set(['a', 'b']);
    expect(openSection(previous, 'b')).toBe(previous);
  });
});

describe('closeSection', () => {
  it('removes the id when present', () => {
    const previous = new Set(['a', 'b']);
    const next = closeSection(previous, 'b');
    expect(next).toEqual(new Set(['a']));
  });

  it('returns the same reference when the id is already absent', () => {
    const previous = new Set(['a']);
    expect(closeSection(previous, 'b')).toBe(previous);
  });
});

describe('addAllToSet', () => {
  it('adds every section id', () => {
    const previous = new Set(['a']);
    const next = addAllToSet(previous, sections);
    expect(next).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns the same reference when nothing changes', () => {
    const previous = new Set(['a', 'b', 'c']);
    expect(addAllToSet(previous, sections)).toBe(previous);
  });
});

describe('removeAllFromSet', () => {
  it('removes every section id', () => {
    const previous = new Set(['a', 'b', 'c', 'd']);
    const next = removeAllFromSet(previous, sections);
    expect(next).toEqual(new Set(['d']));
  });

  it('returns the same reference when nothing changes', () => {
    const previous = new Set(['d']);
    expect(removeAllFromSet(previous, sections)).toBe(previous);
  });

  it('returns a new reference when only some of the given ids were present', () => {
    // previous に 'a' は含まれるが 'b' は含まれない。'a' の削除で size が変わる
    // ため sameMembers の size チェックだけで「別物」と判定できるケース。
    const previous = new Set(['a', 'd']);
    const next = removeAllFromSet(previous, [sections[0], sections[1]]); // sections[0].id === 'a', sections[1].id === 'b'
    expect(next).toEqual(new Set(['d']));
    expect(next).not.toBe(previous);
  });
});
