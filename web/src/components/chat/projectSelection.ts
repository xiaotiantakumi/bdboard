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

// bdboard-sso1.83 第4段: ChatPanel.tsx から純関数を移動しただけ。挙動は変えていない。
// レビュー major-1: select を出す条件は「選ぶ余地があるか」。複数あるとき、
// および1件しか無くてもまだ選ばれていないとき(チケットのプロジェクトが
// 一覧に無く未選択で固定される経路)は必ず選べるようにする。
export function showProjectSelect(
  projects: readonly ProjectDto[],
  selectedProjectId: string,
): boolean {
  return projects.length > 1 || (projects.length === 1 && selectedProjectId === '');
}

// レビュー major-1: ヒントの条件は送信可否と同じ selectedProjectId === '' 単独。
// projects が空のときだけ「選べ」ではなく状況の説明に差し替える。
export function projectSelectionHint(
  projects: readonly ProjectDto[],
  selectedProjectId: string,
): string | null {
  return selectedProjectId !== ''
    ? null
    : projects.length === 0
      ? 'プロジェクトを読み込めていません。一覧が表示されない場合はスキャンルートの設定を確認してください。'
      : '送信先のプロジェクトを選んでください。選ぶまで送信できません。';
}
