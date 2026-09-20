// bdboard-sso1.41: DependencyGraphView.tsx 本体にあった useQuery 1本・
// useState 3本・useEffect 1本・useMemo 3本と、その間の派生値(fullGraph /
// canFocus / focusActive / tooManyNodes)を、挙動を変えずにこの関心フックへ
// まとめて移したもの。フックの呼び出し順(useQuery → useState x3 → useEffect →
// useMemo x3、コード上の元の並びのまま)・依存配列・queryKey は移動前と同一。
// 呼び出し元 DependencyGraphView はこのフック1つだけを呼ぶため、Reactから見た
// 通算のフック呼び出し順序は変わらない。effect は元から1本のみで、他の
// effect/ref との相対順序に影響する共有 ref はここには存在しない。
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { fetchDependencyGraph } from '../../api';
import {
  computeFocusedGraph,
  computeLayout,
  MAX_NODES_UNFILTERED,
  type FocusDepth,
  type NodeLayout,
} from './dependencyGraphHelpers';

export function useDependencyGraphView(
  projectIds: readonly string[],
  externalFocusTicketId: string | undefined,
) {
  const projectIdsKey = projectIds.join(',');
  const query = useQuery({
    queryKey: ['dependency-graph', projectIdsKey],
    queryFn: () => fetchDependencyGraph(projectIds),
  });

  const [focusTicketId, setFocusTicketId] = useState<string | undefined>(
    externalFocusTicketId,
  );
  const [focusEnabled, setFocusEnabled] = useState(true);
  const [focusDepth, setFocusDepth] = useState<FocusDepth>(2);

  useEffect(() => {
    setFocusTicketId(externalFocusTicketId);
  }, [externalFocusTicketId]);

  const fullGraph = query.data;
  const canFocus =
    focusTicketId !== undefined &&
    fullGraph !== undefined &&
    fullGraph.nodes.some((node) => node.ticketId === focusTicketId);
  const focusActive = canFocus && focusEnabled;

  const displayGraph = useMemo(() => {
    if (fullGraph === undefined) {
      return undefined;
    }
    if (!focusActive || focusTicketId === undefined) {
      return fullGraph;
    }
    return computeFocusedGraph(fullGraph, focusTicketId, focusDepth);
  }, [fullGraph, focusActive, focusTicketId, focusDepth]);

  const layout = useMemo(() => {
    if (displayGraph === undefined) {
      return null;
    }
    return computeLayout(displayGraph);
  }, [displayGraph]);

  const layoutById = useMemo(() => {
    if (layout === null) {
      return new Map<string, NodeLayout>();
    }
    return new Map(layout.nodes.map((entry) => [entry.node.ticketId, entry]));
  }, [layout]);

  const tooManyNodes =
    projectIds.length === 0 &&
    displayGraph !== undefined &&
    displayGraph.nodes.length >= MAX_NODES_UNFILTERED;

  return {
    query,
    focusTicketId,
    setFocusTicketId,
    focusEnabled,
    setFocusEnabled,
    focusDepth,
    setFocusDepth,
    canFocus,
    focusActive,
    fullGraph,
    displayGraph,
    layout,
    layoutById,
    tooManyNodes,
  };
}
