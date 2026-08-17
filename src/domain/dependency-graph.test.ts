import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import { buildDependencyGraph } from './dependency-graph.js';
import { makeTicket } from './test-support.js';

function edge(
  issueId: string,
  dependsOnId: string,
  kind: DependencyEdge['kind'],
): DependencyEdge {
  return { issueId, dependsOnId, kind };
}

describe('buildDependencyGraph', () => {
  it('returns empty nodes and edges for an empty ticket list', () => {
    expect(buildDependencyGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it('builds a simple blocks chain A→B→C with ascending layers', () => {
    const graph = buildDependencyGraph([
      makeTicket({
        id: 'bdboard-a',
        dependencies: [edge('bdboard-b', 'bdboard-a', 'blocks')],
      }),
      makeTicket({
        id: 'bdboard-b',
        dependencies: [edge('bdboard-c', 'bdboard-b', 'blocks')],
      }),
      makeTicket({ id: 'bdboard-c', dependencies: [] }),
    ]);

    expect(graph.edges).toEqual([
      { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
      { from: 'bdboard-c', to: 'bdboard-b', kind: 'blocks' },
    ]);

    const layerById = new Map(graph.nodes.map((node) => [node.ticketId, node.layer]));
    expect(layerById.get('bdboard-a')).toBe(0);
    expect(layerById.get('bdboard-b')).toBe(1);
    expect(layerById.get('bdboard-c')).toBe(2);
  });

  it('assigns the same layer to branch siblings and a higher layer to their dependent', () => {
    const graph = buildDependencyGraph([
      makeTicket({ id: 'bdboard-a', dependencies: [] }),
      makeTicket({
        id: 'bdboard-b',
        dependencies: [edge('bdboard-b', 'bdboard-a', 'blocks')],
      }),
      makeTicket({
        id: 'bdboard-c',
        dependencies: [edge('bdboard-c', 'bdboard-a', 'blocks')],
      }),
      makeTicket({
        id: 'bdboard-d',
        dependencies: [
          edge('bdboard-d', 'bdboard-b', 'blocks'),
          edge('bdboard-d', 'bdboard-c', 'blocks'),
        ],
      }),
    ]);

    const layerById = new Map(graph.nodes.map((node) => [node.ticketId, node.layer]));
    expect(layerById.get('bdboard-a')).toBe(0);
    expect(layerById.get('bdboard-b')).toBe(1);
    expect(layerById.get('bdboard-c')).toBe(1);
    expect(layerById.get('bdboard-d')).toBe(2);
  });

  it('places cyclic blocks nodes in the same final layer without hanging', () => {
    const graph = buildDependencyGraph([
      makeTicket({
        id: 'bdboard-a',
        dependencies: [edge('bdboard-a', 'bdboard-b', 'blocks')],
      }),
      makeTicket({
        id: 'bdboard-b',
        dependencies: [edge('bdboard-b', 'bdboard-a', 'blocks')],
      }),
    ]);

    const layerById = new Map(graph.nodes.map((node) => [node.ticketId, node.layer]));
    expect(layerById.get('bdboard-a')).toBe(0);
    expect(layerById.get('bdboard-b')).toBe(0);
  });

  it('includes parent-child edges without using them for layer assignment', () => {
    const graph = buildDependencyGraph([
      makeTicket({
        id: 'bdboard-parent',
        dependencies: [edge('bdboard-child', 'bdboard-parent', 'parent-child')],
      }),
      makeTicket({
        id: 'bdboard-child',
        dependencies: [edge('bdboard-child', 'bdboard-parent', 'parent-child')],
      }),
    ]);

    expect(graph.edges).toEqual([
      {
        from: 'bdboard-child',
        to: 'bdboard-parent',
        kind: 'parent-child',
      },
    ]);
    expect(graph.nodes.every((node) => node.layer === 0)).toBe(true);
  });

  it('drops edges whose endpoint ticket is missing from the input set', () => {
    const graph = buildDependencyGraph([
      makeTicket({
        id: 'bdboard-local',
        dependencies: [
          edge('bdboard-local', 'bdboard-external', 'blocks'),
          edge('bdboard-local', 'bdboard-parent', 'parent-child'),
        ],
      }),
      makeTicket({
        id: 'bdboard-parent',
        dependencies: [edge('bdboard-local', 'bdboard-parent', 'parent-child')],
      }),
    ]);

    expect(graph.edges).toEqual([
      {
        from: 'bdboard-local',
        to: 'bdboard-parent',
        kind: 'parent-child',
      },
    ]);
    expect(graph.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-local',
      'bdboard-parent',
    ]);
  });

  it('ignores related and discovered-from dependency kinds', () => {
    const graph = buildDependencyGraph([
      makeTicket({
        id: 'bdboard-a',
        dependencies: [
          edge('bdboard-a', 'bdboard-b', 'related'),
          edge('bdboard-a', 'bdboard-c', 'discovered-from'),
        ],
      }),
      makeTicket({ id: 'bdboard-b', dependencies: [] }),
      makeTicket({ id: 'bdboard-c', dependencies: [] }),
    ]);

    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});
