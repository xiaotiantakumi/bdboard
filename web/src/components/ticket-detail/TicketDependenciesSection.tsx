// bdboard-sso1.5 (PR-F): TicketDetailPanel.tsx の「Dependencies」表示・編集
// ブロックを移動しただけのコンポーネント。state・mutation・debounce 検索
// effect は useTicketDependencies (親で呼び出し) に残し、値とハンドラを
// props で受け取る表示専用コンポーネント。JSX・className・aria属性・文言・
// DOM構造は移動前から変えていない。
import type { DependencyEdgeDto, TicketSearchResultDto } from '../../api';
import { describeDependencyError } from '../dependencyEditing';
import { TicketIdLink } from './TicketIdLink';

export interface TicketDependenciesSectionProps {
  dependencies: DependencyEdgeDto[];
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  dependencyMutationPending: boolean;
  onRemoveDependency: (dependsOnId: string) => void;
  dependencySearchQuery: string;
  onDependencySearchQueryChange: (value: string) => void;
  hasDependencySearchQuery: boolean;
  dependencySearchLoading: boolean;
  dependencySearchError: Error | null;
  dependencyCandidates: TicketSearchResultDto[];
  onAddDependency: (dependsOnId: string) => void;
  error: unknown;
}

export function TicketDependenciesSection({
  dependencies,
  isTicketOnBoard,
  onOpenTicket,
  dependencyMutationPending,
  onRemoveDependency,
  dependencySearchQuery,
  onDependencySearchQueryChange,
  hasDependencySearchQuery,
  dependencySearchLoading,
  dependencySearchError,
  dependencyCandidates,
  onAddDependency,
  error,
}: TicketDependenciesSectionProps) {
  return (
    <div className="detail-section">
      <h3>Dependencies</h3>
      {dependencies.length > 0 && (
        <ul className="detail-list">
          {dependencies.map((dep) => (
            <li key={`${dep.issueId}-${dep.dependsOnId}-${dep.kind}`}>
              <TicketIdLink
                id={dep.issueId}
                isTicketOnBoard={isTicketOnBoard}
                onOpenTicket={onOpenTicket}
              />
              {' → '}
              <TicketIdLink
                id={dep.dependsOnId}
                isTicketOnBoard={isTicketOnBoard}
                onOpenTicket={onOpenTicket}
              />
              {' '}
              ({dep.kind})
              {dep.kind === 'blocks' && (
                <button
                  type="button"
                  className="btn dependency-remove-btn"
                  aria-label={`${dep.dependsOnId} への依存を削除`}
                  disabled={dependencyMutationPending}
                  onClick={() => onRemoveDependency(dep.dependsOnId)}
                >
                  削除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="dependency-search-label" htmlFor="dependency-search">
        依存を追加(このチケットが待つ相手)
      </label>
      <input
        id="dependency-search"
        type="search"
        className="dependency-search-input"
        value={dependencySearchQuery}
        onChange={(event) => onDependencySearchQueryChange(event.target.value)}
        disabled={dependencyMutationPending}
      />
      {hasDependencySearchQuery && dependencySearchLoading && (
        <p className="detail-help">検索中…</p>
      )}
      {hasDependencySearchQuery &&
        !dependencySearchLoading &&
        dependencySearchError === null &&
        dependencyCandidates.length === 0 && (
          <p className="detail-help">該当するチケットがありません</p>
        )}
      {dependencySearchError !== null && (
        <p className="error-message">{dependencySearchError.message}</p>
      )}
      {dependencyCandidates.length > 0 && (
        <ul className="dependency-suggestions">
          {dependencyCandidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className="dependency-suggestion-btn"
                disabled={dependencyMutationPending}
                onClick={() => onAddDependency(candidate.id)}
              >
                <span className="dependency-suggestion-id">
                  {candidate.id}
                </span>
                <span className="dependency-suggestion-title">
                  {candidate.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p className="error-message">{describeDependencyError(error)}</p>
      )}
    </div>
  );
}
