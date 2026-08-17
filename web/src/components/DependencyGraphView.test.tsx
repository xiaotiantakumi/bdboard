import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DependencyGraphDto, GraphNodeDto } from '../api';
import {
  computeFocusedGraph,
  DependencyGraphView,
  MAX_NODES_UNFILTERED,
} from './DependencyGraphView';

vi.mock('../api', () => ({
  fetchDependencyGraph: vi.fn(),
}));

import { fetchDependencyGraph } from '../api';

const fetchDependencyGraphMock = vi.mocked(fetchDependencyGraph);

function makeNode(
  ticketId: string,
  overrides?: Partial<GraphNodeDto>,
): GraphNodeDto {
  return {
    ticketId,
    projectId: 'proj-1',
    title: `${ticketId} task`,
    status: 'open',
    priority: 2,
    issueType: 'task',
    layer: 0,
    ...overrides,
  };
}

function makeGraph(overrides?: Partial<DependencyGraphDto>): DependencyGraphDto {
  return {
    nodes: [
      makeNode('bdboard-a', { title: 'Alpha task', layer: 0 }),
      makeNode('bdboard-b', { title: 'Beta task', status: 'in_progress', layer: 1 }),
    ],
    edges: [{ from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' }],
    ...overrides,
  };
}

function makeChainGraph(): DependencyGraphDto {
  return {
    nodes: [
      makeNode('bdboard-a', { layer: 0 }),
      makeNode('bdboard-b', { layer: 1 }),
      makeNode('bdboard-c', { layer: 2 }),
      makeNode('bdboard-d', { layer: 0 }),
    ],
    edges: [
      { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
      { from: 'bdboard-c', to: 'bdboard-b', kind: 'blocks' },
      { from: 'bdboard-a', to: 'bdboard-d', kind: 'parent-child' },
    ],
  };
}

function makeDeepChainGraph(): DependencyGraphDto {
  return {
    nodes: [
      makeNode('bdboard-a', { layer: 0 }),
      makeNode('bdboard-b', { layer: 1 }),
      makeNode('bdboard-c', { layer: 2 }),
      makeNode('bdboard-d', { layer: 0 }),
      makeNode('bdboard-e', { layer: 0 }),
    ],
    edges: [
      { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
      { from: 'bdboard-c', to: 'bdboard-b', kind: 'blocks' },
      { from: 'bdboard-a', to: 'bdboard-d', kind: 'parent-child' },
      { from: 'bdboard-d', to: 'bdboard-e', kind: 'parent-child' },
    ],
  };
}

function renderDependencyGraphView(
  options?: {
    projectIds?: readonly string[];
    focusTicketId?: string;
    onCardClick?: (ticketId: string) => void;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const onCardClick = options?.onCardClick ?? vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <DependencyGraphView
        projectIds={options?.projectIds ?? []}
        focusTicketId={options?.focusTicketId}
        onCardClick={onCardClick}
      />
    </QueryClientProvider>,
  );

  return { onCardClick };
}

describe('computeFocusedGraph', () => {
  it('includes only 1-hop neighbors for depth=1', () => {
    const graph = makeChainGraph();
    const focused = computeFocusedGraph(graph, 'bdboard-b', 1);

    expect(focused.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
      'bdboard-c',
    ]);
    expect(focused.edges).toEqual([
      { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
      { from: 'bdboard-c', to: 'bdboard-b', kind: 'blocks' },
    ]);
  });

  it('includes 2-hop neighbors for depth=2', () => {
    const graph = makeChainGraph();
    const focused = computeFocusedGraph(graph, 'bdboard-b', 2);

    expect(focused.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
      'bdboard-c',
      'bdboard-d',
    ]);
  });

  it('includes the full connected component for depth=all', () => {
    const graph: DependencyGraphDto = {
      nodes: [
        makeNode('bdboard-a'),
        makeNode('bdboard-b'),
        makeNode('bdboard-isolated'),
      ],
      edges: [{ from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' }],
    };

    const focused = computeFocusedGraph(graph, 'bdboard-a', 'all');

    expect(focused.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
    expect(focused.nodes.some((node) => node.ticketId === 'bdboard-isolated')).toBe(false);
  });

  it('explores edges undirectionally so both sides of blocks are included', () => {
    const graph = makeGraph();
    const focused = computeFocusedGraph(graph, 'bdboard-a', 1);

    expect(focused.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
  });

  it('explores parent-child edges undirectionally', () => {
    const graph = makeChainGraph();
    const focused = computeFocusedGraph(graph, 'bdboard-d', 1);

    expect(focused.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-a',
      'bdboard-d',
    ]);
    expect(focused.edges).toEqual([
      { from: 'bdboard-a', to: 'bdboard-d', kind: 'parent-child' },
    ]);
  });

  it('drops edges when either endpoint is outside the focused node set', () => {
    const graph: DependencyGraphDto = {
      nodes: [makeNode('bdboard-a'), makeNode('bdboard-b'), makeNode('bdboard-c')],
      edges: [
        { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
        { from: 'bdboard-c', to: 'bdboard-b', kind: 'blocks' },
      ],
    };

    const focused = computeFocusedGraph(graph, 'bdboard-a', 1);

    expect(focused.edges).toEqual([
      { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
    ]);
  });

  it('preserves edge kind values', () => {
    const graph = makeChainGraph();
    const focused = computeFocusedGraph(graph, 'bdboard-a', 'all');

    expect(focused.edges).toEqual(
      expect.arrayContaining([
        { from: 'bdboard-b', to: 'bdboard-a', kind: 'blocks' },
        { from: 'bdboard-a', to: 'bdboard-d', kind: 'parent-child' },
      ]),
    );
  });
});

describe('DependencyGraphView', () => {
  beforeEach(() => {
    fetchDependencyGraphMock.mockReset();
  });

  it('renders graph nodes after loading', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeGraph());

    renderDependencyGraphView();

    expect(await screen.findByText('bdboard-a')).toBeInTheDocument();
    expect(screen.getByText('Alpha task')).toBeInTheDocument();
    expect(screen.getByText('bdboard-b')).toBeInTheDocument();
  });

  it('shows an empty state when there are no nodes', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeGraph({ nodes: [], edges: [] }));

    renderDependencyGraphView();

    expect(
      await screen.findByText('表示できる依存関係がありません'),
    ).toBeInTheDocument();
  });

  it('shows a loading state while fetching', () => {
    fetchDependencyGraphMock.mockReturnValue(new Promise(() => undefined));

    renderDependencyGraphView();

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });

  it('shows an error state when fetching fails', async () => {
    fetchDependencyGraphMock.mockRejectedValue(new Error('network failed'));

    renderDependencyGraphView();

    expect(await screen.findByText('network failed')).toBeInTheDocument();
  });

  it('calls onCardClick when a node is clicked', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeGraph());

    const { onCardClick } = renderDependencyGraphView();

    const node = await screen.findByRole('button', { name: /bdboard-a/i });
    fireEvent.click(node);

    expect(onCardClick).toHaveBeenCalledWith('bdboard-a');
  });

  it('passes projectIds to fetchDependencyGraph when provided', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeGraph());

    renderDependencyGraphView({ projectIds: ['proj-a', 'proj-b'] });

    await screen.findByText('bdboard-a');

    expect(fetchDependencyGraphMock).toHaveBeenCalledWith(['proj-a', 'proj-b']);
  });

  it('shows a filter hint when unfiltered graph exceeds the node limit', async () => {
    const nodes = Array.from({ length: MAX_NODES_UNFILTERED }, (_, index) =>
      makeNode(`bdboard-${index}`),
    );

    fetchDependencyGraphMock.mockResolvedValue(makeGraph({ nodes, edges: [] }));

    renderDependencyGraphView({ projectIds: [] });

    expect(
      await screen.findByText(/プロジェクトを絞り込んでください/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'チケット依存関係グラフ' })).toBeNull();
  });

  it('renders only focused nodes when focusTicketId is provided', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeDeepChainGraph());

    renderDependencyGraphView({ focusTicketId: 'bdboard-b' });

    expect(await screen.findByText('bdboard-b')).toBeInTheDocument();
    expect(screen.getByText('bdboard-a')).toBeInTheDocument();
    expect(screen.getByText('bdboard-c')).toBeInTheDocument();
    expect(screen.getByText('bdboard-d')).toBeInTheDocument();
    expect(screen.queryByText('bdboard-e')).toBeNull();
    expect(
      screen.getByText(/bdboard-b を中心に 4 件を表示中（全 5 件）/),
    ).toBeInTheDocument();
  });

  it('shows all nodes again when returning to full view', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeDeepChainGraph());

    renderDependencyGraphView({ focusTicketId: 'bdboard-b' });

    await screen.findByText('bdboard-b');
    expect(screen.queryByText('bdboard-e')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '全体表示に戻す' }));

    expect(await screen.findByText('bdboard-e')).toBeInTheDocument();
    expect(screen.queryByText(/を中心に/)).toBeNull();
  });

  it('falls back to full view when focusTicketId is not in the graph', async () => {
    fetchDependencyGraphMock.mockResolvedValue(makeChainGraph());

    renderDependencyGraphView({ focusTicketId: 'bdboard-missing' });

    expect(await screen.findByText('bdboard-d')).toBeInTheDocument();
    expect(screen.queryByLabelText('フォーカス表示')).toBeNull();
    expect(screen.queryByText(/を中心に/)).toBeNull();
  });

  it('bypasses the unfiltered node guard when focus reduces the graph below the limit', async () => {
    const neighborCount = 10;
    const nodes = [
      makeNode('bdboard-center', { layer: 1 }),
      ...Array.from({ length: neighborCount }, (_, index) =>
        makeNode(`bdboard-neighbor-${index}`, { layer: 0 }),
      ),
      ...Array.from({ length: MAX_NODES_UNFILTERED }, (_, index) =>
        makeNode(`bdboard-isolated-${index}`, { layer: 2 }),
      ),
    ];
    const edges = Array.from({ length: neighborCount }, (_, index) => ({
      from: 'bdboard-center',
      to: `bdboard-neighbor-${index}`,
      kind: 'blocks' as const,
    }));

    fetchDependencyGraphMock.mockResolvedValue({ nodes, edges });

    renderDependencyGraphView({ projectIds: [], focusTicketId: 'bdboard-center' });

    expect(await screen.findByRole('img', { name: 'チケット依存関係グラフ' })).toBeInTheDocument();
    expect(screen.queryByText(/プロジェクトを絞り込んでください/)).toBeNull();
    expect(screen.getByText('bdboard-neighbor-0')).toBeInTheDocument();
    expect(screen.queryByText('bdboard-isolated-0')).toBeNull();
  });

  it('shows the filter hint when focused graph still exceeds the node limit', async () => {
    const nodes = [
      makeNode('bdboard-center'),
      ...Array.from({ length: MAX_NODES_UNFILTERED }, (_, index) =>
        makeNode(`bdboard-neighbor-${index}`),
      ),
    ];
    const edges = Array.from({ length: MAX_NODES_UNFILTERED }, (_, index) => ({
      from: 'bdboard-center',
      to: `bdboard-neighbor-${index}`,
      kind: 'blocks' as const,
    }));

    fetchDependencyGraphMock.mockResolvedValue({ nodes, edges });

    renderDependencyGraphView({ projectIds: [], focusTicketId: 'bdboard-center' });

    expect(
      await screen.findByText(/プロジェクトを絞り込んでください/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'チケット依存関係グラフ' })).toBeNull();
  });
});
