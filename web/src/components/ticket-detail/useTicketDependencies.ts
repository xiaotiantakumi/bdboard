// bdboard-sso1.5 (PR-F): TicketDetailPanel.tsx の「依存関係(Dependencies)編集」
// に関する state + debounced 検索 effect + mutation + handler 一式を、挙動を
// 変えずにこのカスタムフックへ抽出しただけのファイル。useTicketLabels と同じ
// 抽出パターン。呼び出し順序・依存配列・queryKey・onSuccess の中身は移動前
// から変えていない。debounce 検索 effect の依存配列は元の実装どおり
// `data`(参照全体)を含む — 個別フィールドへ分解すると再実行タイミングが
// 変わってしまうため、そのまま渡す。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  deleteTicketDependency,
  postTicketDependency,
  searchTickets,
  type TicketSearchResultDto,
} from '../../api';
import { filterDependencyCandidates } from '../dependencyEditing';
import { DEPENDENCY_SEARCH_DEBOUNCE_MS, DEPENDENCY_SEARCH_LIMIT } from './constants';

/** debounce 検索 effect が参照する data の最小形。TicketDetailDto はこれを
 * 満たすので、呼び出し側は data をそのまま渡せる(参照同一性を保つため)。 */
export interface TicketDependenciesSourceData {
  readonly id: string;
  readonly projectId: string;
  readonly dependencies: readonly { readonly dependsOnId: string }[];
}

export interface TicketDependenciesEditing {
  readonly dependencySearchQuery: string;
  readonly setDependencySearchQuery: (value: string) => void;
  readonly hasDependencySearchQuery: boolean;
  readonly dependencySearchLoading: boolean;
  readonly dependencySearchError: Error | null;
  readonly dependencyCandidates: TicketSearchResultDto[];
  readonly dependencyMutationPending: boolean;
  readonly error: unknown;
  readonly handleAddDependency: (dependsOnId: string) => void;
  readonly handleRemoveDependency: (dependsOnId: string) => void;
  /** ticketId 切り替え時のフルリセット (resetFormState から呼ぶ)。 */
  readonly reset: () => void;
}

export function useTicketDependencies(
  ticketId: string,
  data: TicketDependenciesSourceData | undefined,
): TicketDependenciesEditing {
  const queryClient = useQueryClient();
  const [dependencySearchQuery, setDependencySearchQuery] = useState('');
  const [dependencyCandidates, setDependencyCandidates] = useState<
    TicketSearchResultDto[]
  >([]);
  const [dependencySearchLoading, setDependencySearchLoading] = useState(false);
  const [dependencySearchError, setDependencySearchError] =
    useState<Error | null>(null);

  const trimmedDependencySearchQuery = dependencySearchQuery.trim();
  const hasDependencySearchQuery = trimmedDependencySearchQuery.length > 0;

  useEffect(() => {
    if (data === undefined || !hasDependencySearchQuery) {
      setDependencyCandidates([]);
      setDependencySearchLoading(false);
      setDependencySearchError(null);
      return;
    }

    let cancelled = false;
    setDependencySearchLoading(true);
    setDependencySearchError(null);

    const handle = window.setTimeout(() => {
      void searchTickets(trimmedDependencySearchQuery, DEPENDENCY_SEARCH_LIMIT)
        .then((hits) => {
          if (cancelled) return;
          setDependencyCandidates(
            filterDependencyCandidates(hits, {
              ticketId: data.id,
              projectId: data.projectId,
              existingDependsOnIds: data.dependencies.map(
                (dep) => dep.dependsOnId,
              ),
            }),
          );
          setDependencySearchLoading(false);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setDependencySearchError(
            caught instanceof Error ? caught : new Error('検索に失敗しました'),
          );
          setDependencyCandidates([]);
          setDependencySearchLoading(false);
        });
    }, DEPENDENCY_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    data,
    hasDependencySearchQuery,
    trimmedDependencySearchQuery,
  ]);

  const addDependencyMutation = useMutation({
    mutationFn: async (dependsOnId: string) => {
      await postTicketDependency(ticketId, dependsOnId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      setDependencySearchQuery('');
      setDependencyCandidates([]);
    },
  });

  const removeDependencyMutation = useMutation({
    mutationFn: async (dependsOnId: string) => {
      await deleteTicketDependency(ticketId, dependsOnId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
    },
  });

  const dependencyMutationPending =
    addDependencyMutation.isPending || removeDependencyMutation.isPending;
  const dependencyMutationError =
    addDependencyMutation.error ?? removeDependencyMutation.error;

  const handleAddDependency = useCallback(
    (dependsOnId: string) => {
      addDependencyMutation.mutate(dependsOnId);
    },
    [addDependencyMutation],
  );

  const handleRemoveDependency = useCallback(
    (dependsOnId: string) => {
      removeDependencyMutation.mutate(dependsOnId);
    },
    [removeDependencyMutation],
  );

  const reset = useCallback(() => {
    setDependencySearchQuery('');
    setDependencyCandidates([]);
    setDependencySearchLoading(false);
    setDependencySearchError(null);
  }, []);

  return {
    dependencySearchQuery,
    setDependencySearchQuery,
    hasDependencySearchQuery,
    dependencySearchLoading,
    dependencySearchError,
    dependencyCandidates,
    dependencyMutationPending,
    error: dependencyMutationError,
    handleAddDependency,
    handleRemoveDependency,
    reset,
  };
}
