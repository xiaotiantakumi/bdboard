// bdboard-sso1.12: dto.ts のモジュール分割。依存関係グラフ (DependencyGraphView)
// の DTO。dependency-graph-routes.ts が参照する (barrel 経由。bdboard-sso1.61 で
// hygiene-routes.ts から分割)。
import type { DependencyGraph } from '../../../domain/dependency-graph.js';

export interface GraphNodeDto {
  ticketId: string;
  projectId: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  layer: number;
}

export interface GraphEdgeDto {
  from: string;
  to: string;
  kind: 'blocks' | 'parent-child';
}

export interface DependencyGraphDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export function toDependencyGraphDto(graph: DependencyGraph): DependencyGraphDto {
  return {
    nodes: graph.nodes.map((node) => ({
      ticketId: node.ticketId,
      projectId: node.projectId,
      title: node.title,
      status: node.status,
      priority: node.priority,
      issueType: node.issueType,
      layer: node.layer,
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
    })),
  };
}
