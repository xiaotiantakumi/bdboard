import { ApiError, type TicketSearchResultDto } from '../api';
import { CONFLICT_WRITE_HELP, writeAccessErrorMessage } from '../writeAccessMessage';

/**
 * DELETE /api/tickets/:id/dependencies/:dependsOnId が 409 で返す固定文字列
 * (src/interface/http/routes.ts)。キャッシュ上に無いエッジを消そうとした場合
 * ("dependency not found on this ticket") — 別セッションが先に同じ依存関係を
 * 削除済みで、このタブのキャッシュが古いだけ、というケース(bdboard-y2c)。
 * web/ から src/ は import できない(別 tsconfig・レイヤ境界)ので、
 * writeAccessMessage.ts の 403/409 定数と同じ理由で意図的な二重定義。
 * サーバー側の文字列を変えるならここも変える。
 */
const SERVER_DEPENDENCY_NOT_FOUND = 'dependency not found on this ticket';

export interface DependencyCandidateFilter {
  ticketId: string;
  projectId: string;
  existingDependsOnIds: readonly string[];
}

export function filterDependencyCandidates(
  results: readonly TicketSearchResultDto[],
  filter: DependencyCandidateFilter,
): TicketSearchResultDto[] {
  const existingIds = new Set(filter.existingDependsOnIds);
  return results.filter(
    (result) =>
      result.projectId === filter.projectId &&
      result.id !== filter.ticketId &&
      !existingIds.has(result.id),
  );
}

export function describeDependencyError(error: unknown): string {
  // 認可 403 は理由と次の行動が分かる説明に差し替える(bdboard-cu4)。
  const writeAccessMessage = writeAccessErrorMessage(error);
  if (writeAccessMessage !== null) {
    return writeAccessMessage;
  }
  // 409(dependency not found on this ticket): stale なキャッシュ上のエッジを
  // 削除しようとした = 別セッションが既に削除済みの可能性が高い。他の書き込み系
  // 409 と同じ「他のセッションが先に変更した」文言(writeAccessMessage.ts の
  // CONFLICT_WRITE_HELP)に揃える(bdboard-y2c)。
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.errorMessage === SERVER_DEPENDENCY_NOT_FOUND
  ) {
    return CONFLICT_WRITE_HELP;
  }
  if (error instanceof ApiError && error.detail !== undefined) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '依存関係の更新に失敗しました';
}
