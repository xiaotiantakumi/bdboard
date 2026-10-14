import { ApiError } from '../../api/http';

export function localFileErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 413) return 'ファイルが大きすぎて表示できません。';
  if (status === 415) return 'この種類のファイルは表示できません。';
  if (status === 403) return 'ローカルで開いたときだけ表示できます。';
  if (status === 400 || status === 404) return 'ファイルが見つからないか、開けない場所にあります。';
  return 'ファイルを読み込めませんでした。';
}
