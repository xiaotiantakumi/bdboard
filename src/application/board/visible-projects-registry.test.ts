import { describe, expect, it } from 'vitest';
import { createVisibleProjectsRegistry } from './visible-projects-registry.js';

describe('createVisibleProjectsRegistry', () => {
  it('starts empty', () => {
    const r = createVisibleProjectsRegistry();
    expect(r.hasReports).toBe(false);
    expect(r.isVisible('a')).toBe(false);
  });

  it('takes the union across clients and replaces a client report', () => {
    const r = createVisibleProjectsRegistry();
    r.report('c1', { projectIds: ['a', 'b'] });
    r.report('c2', { projectIds: ['b', 'c'] });
    expect(['a', 'b', 'c', 'z'].map((id) => r.isVisible(id))).toEqual([true, true, true, false]);
    r.report('c1', { projectIds: ['z'] });
    expect(['a', 'b', 'c', 'z'].map((id) => r.isVisible(id))).toEqual([false, true, true, true]);
  });

  it('treats a wildcard report as every project visible, including unknown ones', () => {
    const r = createVisibleProjectsRegistry();
    r.report('c1', { all: true });
    expect(r.hasReports).toBe(true);
    expect(r.isVisible('anything')).toBe(true);
    r.report('c1', { projectIds: ['a'] });
    expect(r.isVisible('anything')).toBe(false);
  });

  it('expires reports after the TTL and heartbeats extend it', () => {
    let t = 0;
    const r = createVisibleProjectsRegistry({ now: () => t, ttlMs: 1000 });
    r.report('c1', { projectIds: ['a'] });
    r.report('c2', { projectIds: ['b'] });
    t = 800;
    r.report('c1', { projectIds: ['a'] });
    t = 1200;
    expect(r.isVisible('a')).toBe(true);
    expect(r.isVisible('b')).toBe(false);
    t = 2000;
    expect(r.hasReports).toBe(false);
    expect(r.isVisible('a')).toBe(false);
  });

  it('returns only newly visible ids from report', () => {
    const r = createVisibleProjectsRegistry();
    expect(r.report('c1', { projectIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(r.report('c1', { projectIds: ['a', 'b'] })).toEqual([]);
    expect(r.report('c2', { projectIds: ['b', 'c'] })).toEqual(['c']);
  });

  it('caps the number of clients, evicting the oldest report', () => {
    const r = createVisibleProjectsRegistry({ maxClients: 2 });
    r.report('c1', { projectIds: ['a'] });
    r.report('c2', { projectIds: ['b'] });
    r.report('c1', { projectIds: ['a'] }); // refreshes c1, c2 is now oldest
    r.report('c3', { projectIds: ['c'] });
    expect(r.isVisible('a')).toBe(true);
    expect(r.isVisible('b')).toBe(false);
    expect(r.isVisible('c')).toBe(true);
  });
});

describe('remembered local selection (bdboard-u8p9)', () => {
  it('is null before any report and returns a copy afterwards', () => {
    const registry = createVisibleProjectsRegistry();
    expect(registry.getLocalSelection()).toBeNull();
    registry.rememberLocalSelection(['/p/a']);
    const first = registry.getLocalSelection();
    expect(first).toEqual(['/p/a']);
    (first as string[]).push('/p/x');
    expect(registry.getLocalSelection()).toEqual(['/p/a']);
  });

  it('does not expire with the visibility TTL and keeps an empty selection', () => {
    let t = 0;
    const registry = createVisibleProjectsRegistry({ now: () => t, ttlMs: 10 });
    registry.rememberLocalSelection([]);
    t = 1_000_000;
    expect(registry.getLocalSelection()).toEqual([]);
  });
});
