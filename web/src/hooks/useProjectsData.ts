import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { fetchProjects } from '../api';
import { sanitizeProjectFilter } from '../uiPersistedState';

/**
 * bdboard-62p4 PR-3: App.tsx から `projects` クエリと、その `data` から導出する
 * 4つの useMemo (chatProjects/projectNames/projectActiveSessions/
 * projectRootPaths)、および選択中プロジェクトIDをボードに実在するものへ
 * 正規化する useEffect を集約した。queryKey/queryFn/各 useMemo の依存配列と
 * 本体、sanitize effect の中身は元の App.tsx から1文字も変えていない
 * (元位置: L238-249, L433-458 付近)。
 *
 * setSelectedProjectIds は usePersistedState の setter をそのまま呼び出し元
 * (App.tsx) から受け取る。フック内で `useState` を新たに持たせると、
 * localStorage 永続化と App.tsx 側の他の利用箇所 (プリセット適用・
 * ハンドラ群) との単一の真実源が二重化してしまうため。
 */
export interface UseProjectsDataParams {
  setSelectedProjectIds: (
    value: string[] | ((current: string[]) => string[]),
  ) => void;
}

export function useProjectsData({ setSelectedProjectIds }: UseProjectsDataParams) {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });

  // N7: `projectsQuery.data ?? []` builds a fresh array literal on every
  // render while the query is still loading. ChatPanel's ticket-context
  // effect (bdboard-3tw.104.14 S1) depends on `projects` to re-evaluate once
  // the list arrives, so an unstable reference here would make that effect
  // re-run on every unrelated App re-render in the meantime. Memoize a
  // stable fallback so it only changes when the query data actually does.
  const chatProjects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project.name);
    }
    return map;
  }, [projectsQuery.data]);

  const projectActiveSessions = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project.activeSessionCount);
    }
    return map;
  }, [projectsQuery.data]);

  const projectRootPaths = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project.rootPath);
    }
    return map;
  }, [projectsQuery.data]);

  useEffect(() => {
    const projects = projectsQuery.data;
    if (projects === undefined) {
      return;
    }
    const availableProjectIds = projects.map((project) => project.id);
    setSelectedProjectIds((current) =>
      sanitizeProjectFilter(current, availableProjectIds),
    );
  }, [projectsQuery.data, setSelectedProjectIds]);

  return {
    projectsQuery,
    chatProjects,
    projectNames,
    projectActiveSessions,
    projectRootPaths,
  };
}
