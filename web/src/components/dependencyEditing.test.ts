import { describe, expect, it } from 'vitest';
import { ApiError, type TicketSearchResultDto } from '../api';
import { CONFLICT_WRITE_HELP } from '../writeAccessMessage';
import {
  describeDependencyError,
  filterDependencyCandidates,
} from './dependencyEditing';

const sampleResults: TicketSearchResultDto[] = [
  {
    id: 'bdboard-same.1',
    projectId: 'proj-1',
    projectName: 'Same Project',
    title: 'Same project ticket',
    status: 'open',
    priority: 2,
    issueType: 'task',
  },
  {
    id: 'bdboard-other.1',
    projectId: 'proj-2',
    projectName: 'Other Project',
    title: 'Other project ticket',
    status: 'open',
    priority: 2,
    issueType: 'task',
  },
  {
    id: 'bdboard-self',
    projectId: 'proj-1',
    projectName: 'Same Project',
    title: 'Self ticket',
    status: 'open',
    priority: 2,
    issueType: 'task',
  },
  {
    id: 'bdboard-existing',
    projectId: 'proj-1',
    projectName: 'Same Project',
    title: 'Already linked',
    status: 'open',
    priority: 2,
    issueType: 'task',
  },
];

describe('filterDependencyCandidates', () => {
  const filter = {
    ticketId: 'bdboard-self',
    projectId: 'proj-1',
    existingDependsOnIds: ['bdboard-existing'],
  };

  it('excludes candidates from other projects', () => {
    const filtered = filterDependencyCandidates(sampleResults, filter);
    expect(filtered.map((entry) => entry.id)).not.toContain('bdboard-other.1');
  });

  it('excludes the current ticket itself', () => {
    const filtered = filterDependencyCandidates(sampleResults, filter);
    expect(filtered.map((entry) => entry.id)).not.toContain('bdboard-self');
  });

  it('excludes tickets that are already dependencies', () => {
    const filtered = filterDependencyCandidates(sampleResults, filter);
    expect(filtered.map((entry) => entry.id)).not.toContain('bdboard-existing');
  });

  it('keeps same-project tickets that are eligible', () => {
    const filtered = filterDependencyCandidates(sampleResults, filter);
    expect(filtered.map((entry) => entry.id)).toEqual(['bdboard-same.1']);
  });
});

describe('describeDependencyError', () => {
  it('prefers ApiError detail over message', () => {
    const error = new ApiError(502, 'failed to add dependency', {
      errorMessage: 'failed to add dependency',
      detail: 'would create circular dependency: bdboard-a -> bdboard-b',
    });

    expect(describeDependencyError(error)).toBe(
      'would create circular dependency: bdboard-a -> bdboard-b',
    );
  });

  it('falls back to message when detail is absent', () => {
    const error = new ApiError(502, 'failed to add dependency', {
      errorMessage: 'failed to add dependency',
    });

    expect(describeDependencyError(error)).toBe('failed to add dependency');
  });

  it('falls back to generic message for unknown errors', () => {
    expect(describeDependencyError('unexpected')).toBe(
      '依存関係の更新に失敗しました',
    );
  });

  it('localizes the dep-delete 409 (stale cache) into the shared conflict message', () => {
    // routes.ts の dep-delete エンドポイントが返す実際のペイロード形状
    // ({ error: 'dependency not found on this ticket', id, dependsOnId }, 409):
    // detail フィールドは無く、error(=errorMessage) だけが生英語で入っている。
    const error = new ApiError(409, 'dependency not found on this ticket', {
      errorMessage: 'dependency not found on this ticket',
    });

    expect(describeDependencyError(error)).toBe(CONFLICT_WRITE_HELP);
    // 生の英語メッセージがそのままユーザーに出ないことを明示的に確認する
    // (このテストが守っている回帰そのもの)。
    expect(describeDependencyError(error)).not.toBe(
      'dependency not found on this ticket',
    );
  });

  it('does not localize other 409s from dependency endpoints (ablation guard)', () => {
    // 409 分岐がメッセージ文字列を見ずに status だけで発火するよう壊された場合に
    // 落ちることを狙ったテスト。未知の 409 は従来どおり detail/message にフォール
    // バックする。
    const error = new ApiError(409, 'some other conflict', {
      errorMessage: 'some other conflict',
    });

    expect(describeDependencyError(error)).toBe('some other conflict');
    expect(describeDependencyError(error)).not.toBe(CONFLICT_WRITE_HELP);
  });
});
