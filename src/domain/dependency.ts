import type { TicketId } from './ticket-id.js';

export const KNOWN_DEPENDENCY_KINDS = [
  'blocks',
  'parent-child',
  'related',
  'discovered-from',
] as const;

export type KnownDependencyKind = (typeof KNOWN_DEPENDENCY_KINDS)[number];

export type DependencyKind = KnownDependencyKind | (string & {});

export interface DependencyEdge {
  readonly issueId: TicketId;
  readonly dependsOnId: TicketId;
  readonly kind: DependencyKind;
}

export function isBlockingKind(kind: DependencyKind): boolean {
  return kind === 'blocks';
}

export function blockingEdges(
  edges: readonly DependencyEdge[],
): readonly DependencyEdge[] {
  return edges.filter((edge) => isBlockingKind(edge.kind));
}
