// bdboard-sso1.2: ChatPanel.tsx から純粋ヘルパーを移動しただけのファイル。
// 挙動は一切変えていない。
import type { ProjectDto } from '../../api';

export function resolveInitialProjectId(
  projects: readonly ProjectDto[],
  initialProjectId?: string,
): string {
  if (
    initialProjectId !== undefined &&
    projects.some((project) => project.id === initialProjectId)
  ) {
    return initialProjectId;
  }
  // bdboard-r5we: 「一覧の先頭を暗黙の対象にする」挙動は廃止。プロジェクトが
  // 1件だけなら曖昧さが無いので自動選択してよいが、複数あるときは '' (未選択)
  // のままにして、ユーザーに明示選択させる。
  if (projects.length === 1) {
    return projects[0]?.id ?? '';
  }
  return '';
}
