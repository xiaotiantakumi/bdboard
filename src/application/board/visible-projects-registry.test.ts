import { describe, expect, it } from 'vitest';
import { createVisibleProjectsRegistry } from './visible-projects-registry.js';

describe('createVisibleProjectsRegistry', () => {
  it('starts empty', () => {
    const r = createVisibleProjectsRegistry();
    expect(r.hasReports()).toBe(false);
    expect(r.isVisible('a')).toBe(false);
  });

  it('takes the union across clients and replaces a client report', () => {
    const r = createVisibleProjectsRegistry();
    r.report('c1', ['a', 'b']);
    r.report('c2', ['b', 'c']);
    expect([...r.visibleIds()].sort()).toEqual(['a', 'b', 'c']);
    r.report('c1', ['z']);
    expect([...r.visibleIds()].sort()).toEqual(['b', 'c', 'z']);
  });

  it('expires reports after the TTL and heartbeats extend it', () => {
    let t = 0;
    const r = createVisibleProjectsRegistry({ now: () => t, ttlMs: 1000 });
    r.report('c1', ['a']);
    r.report('c2', ['b']);
    t = 800;
    r.report('c1', ['a']);
    t = 1200;
    expect([...r.visibleIds()]).toEqual(['a']);
    t = 2000;
    expect(r.hasReports()).toBe(false);
    expect(r.isVisible('a')).toBe(false);
  });

  it('returns only newly visible ids from report', () => {
    const r = createVisibleProjectsRegistry();
    expect(r.report('c1', ['a', 'b'])).toEqual(['a', 'b']);
    expect(r.report('c1', ['a', 'b'])).toEqual([]);
    expect(r.report('c2', ['b', 'c'])).toEqual(['c']);
  });
});
