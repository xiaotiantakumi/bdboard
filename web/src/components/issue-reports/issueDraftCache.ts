import type { IssueDraftDetailResponseDto, IssueDraftEditResponseDto, IssueDraftTextEdit } from '../../api/issue-reports';

/**
 * 保存・「自動の文に戻す」の成功の応答を、1 件の取得の問い合わせ (['issue-reports', 'detail', id]) の中身へ置く (bdboard-mqoa)。
 * 応答の draft は GET の draft と同じ形。images・latestHarnessVersion は応答に載らない (編集では変わらない) ので前の値を残す。
 * ETag は応答のものに置き換える (次の保存の If-Match になる)。応答に無ければ消す: 古い ETag を残すと、次の保存が必ず 412 になる。
 */
export function withEditResponse(
  previous: IssueDraftDetailResponseDto,
  response: IssueDraftEditResponseDto,
): IssueDraftDetailResponseDto {
  return {
    draft: response.draft,
    ...(previous.images !== undefined ? { images: previous.images } : {}),
    ...(previous.latestHarnessVersion !== undefined ? { latestHarnessVersion: previous.latestHarnessVersion } : {}),
    ...(response.etag !== undefined ? { etag: response.etag } : {}),
  };
}

/**
 * 変えた欄だけを送る (サーバーは渡された欄にだけ「直した」印を立てる)。比べる相手は編集を始めたときの値: 編集中に
 * 裏で作り直された欄を、触っていないのに古い値で上書きしないため。
 */
export function changedFields(base: { readonly title: string; readonly body: string }, title: string, body: string): IssueDraftTextEdit {
  return {
    ...(title !== base.title ? { title } : {}),
    ...(body !== base.body ? { body } : {}),
  };
}
