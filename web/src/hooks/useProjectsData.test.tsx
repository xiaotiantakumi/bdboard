import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '../api';

vi.mock('../api', () => ({
  fetchProjects: vi.fn(),
}));

import { fetchProjects } from '../api';
import { useProjectsData } from './useProjectsData';

const fetchProjectsMock = vi.mocked(fetchProjects);

function makeProject(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'proj-1',
    name: 'Project One',
    rootPath: '/repo/proj-1',
    prefixes: ['bdboard'],
    sessionCount: 1,
    activeSessionCount: 1,
    incompleteTicketCount: 3,
    sessions: [],
    ...overrides,
  };
}

function renderProjectsData(setSelectedProjectIds = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useProjectsData({ setSelectedProjectIds }), { wrapper });
  return { ...view, queryClient, setSelectedProjectIds };
}

describe('useProjectsData', () => {
  beforeEach(() => {
    fetchProjectsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers the projects query under the exact queryKey used by App.tsx', async () => {
    fetchProjectsMock.mockResolvedValue([]);
    const { result, queryClient } = renderProjectsData();

    await waitFor(() => expect(result.current.projectsQuery.isSuccess).toBe(true));

    const cached = queryClient.getQueryCache().find({ queryKey: ['projects'] });
    expect(cached).toBeDefined();
    expect(cached?.queryKey).toEqual(['projects']);
  });

  it('derives chatProjects/projectNames/projectActiveSessions/projectRootPaths from the fetched projects', async () => {
    const projects = [
      makeProject({ id: 'p-a', name: 'Alpha', rootPath: '/repo/alpha', activeSessionCount: 2 }),
      makeProject({ id: 'p-b', name: 'Beta', rootPath: '/repo/beta', activeSessionCount: 0 }),
    ];
    fetchProjectsMock.mockResolvedValue(projects);
    const { result } = renderProjectsData();

    await waitFor(() => expect(result.current.projectsQuery.data).toEqual(projects));

    expect(result.current.chatProjects).toEqual(projects);
    expect(result.current.projectNames.get('p-a')).toBe('Alpha');
    expect(result.current.projectNames.get('p-b')).toBe('Beta');
    expect(result.current.projectActiveSessions.get('p-a')).toBe(2);
    expect(result.current.projectActiveSessions.get('p-b')).toBe(0);
    expect(result.current.projectRootPaths.get('p-a')).toBe('/repo/alpha');
    expect(result.current.projectRootPaths.get('p-b')).toBe('/repo/beta');
  });

  it('returns a stable empty array for chatProjects while the query is still pending', () => {
    fetchProjectsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderProjectsData();

    expect(result.current.chatProjects).toEqual([]);
    expect(result.current.projectNames.size).toBe(0);
  });

  it('sanitizes the selected project ids once the project list arrives, dropping ids no longer present', async () => {
    const projects = [makeProject({ id: 'p-a' }), makeProject({ id: 'p-b' })];
    fetchProjectsMock.mockResolvedValue(projects);
    const setSelectedProjectIds = vi.fn();
    const { result } = renderProjectsData(setSelectedProjectIds);

    await waitFor(() => expect(result.current.projectsQuery.data).toEqual(projects));
    await waitFor(() => expect(setSelectedProjectIds).toHaveBeenCalledTimes(1));

    const updater = setSelectedProjectIds.mock.calls[0][0] as (
      current: string[],
    ) => string[];
    expect(typeof updater).toBe('function');
    expect(updater(['p-a', 'p-stale', 'p-b'])).toEqual(['p-a', 'p-b']);
  });

  it('does not call setSelectedProjectIds while the projects query is still pending', () => {
    fetchProjectsMock.mockReturnValue(new Promise(() => {}));
    const setSelectedProjectIds = vi.fn();
    renderProjectsData(setSelectedProjectIds);

    expect(setSelectedProjectIds).not.toHaveBeenCalled();
  });
});
