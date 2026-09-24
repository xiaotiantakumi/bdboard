import { describe, expect, it } from 'vitest';
import type { ProjectDto } from '../../api';
import { projectSelectionHint, showProjectSelect } from './projectSelection';

function project(id: string): ProjectDto {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    prefixes: [id],
    sessionCount: 0,
    activeSessionCount: 0,
    incompleteTicketCount: 0,
    sessions: [],
  };
}

// bdboard-sso1.83 第4段: ChatPanel.tsx の showProjectSelect/projectSelectionHint
// 派生値(レビュー major-1)を移した際に足したテスト。
describe('showProjectSelect', () => {
  it('プロジェクトが0件のときは出さない', () => {
    expect(showProjectSelect([], '')).toBe(false);
  });

  it('プロジェクトが1件で既に選択済みのときは出さない', () => {
    expect(showProjectSelect([project('a')], 'a')).toBe(false);
  });

  it('プロジェクトが1件でまだ未選択のときは出す(チケット起点で一覧に無いケース)', () => {
    expect(showProjectSelect([project('a')], '')).toBe(true);
  });

  it('プロジェクトが複数あるときは選択状態によらず出す', () => {
    expect(showProjectSelect([project('a'), project('b')], 'a')).toBe(true);
    expect(showProjectSelect([project('a'), project('b')], '')).toBe(true);
  });
});

describe('projectSelectionHint', () => {
  it('選択済みのときは null', () => {
    expect(projectSelectionHint([project('a')], 'a')).toBeNull();
  });

  it('未選択かつプロジェクトが0件のときは読み込み状況の説明', () => {
    expect(projectSelectionHint([], '')).toBe(
      'プロジェクトを読み込めていません。一覧が表示されない場合はスキャンルートの設定を確認してください。',
    );
  });

  it('未選択かつプロジェクトが1件以上あるときは選択を促す文言', () => {
    expect(projectSelectionHint([project('a')], '')).toBe(
      '送信先のプロジェクトを選んでください。選ぶまで送信できません。',
    );
  });
});
