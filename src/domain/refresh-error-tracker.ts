/**
 * リフレッシュ (画面の自動更新) の失敗を、下書きにする価値のある報告へ絞る (bdboard-4y8q.6.2)。
 *
 * 入力は `refreshProjects` の結果と同じ形 (application 層の型は domain から import できないので、構造的な型を自分で宣言する)。
 * 同じエラーが更新のたびに出続けても報告は 1 時間に 1 回 (間引きは self-error-throttle.ts)。lock-contention と timeout は
 * 一時的なことが多いので 3 回続けて見えたら初めて報告する。配線 (下書きサービスの呼び出し) は 4y8q.6.3。
 */
import type { Project } from './project.js';
import { createSelfErrorMasker } from './self-error-mask.js';
import { createSelfErrorThrottle } from './self-error-throttle.js';
import type { SelfErrorThrottle } from './self-error-throttle.js';

export interface RefreshErrorInput {
  readonly refreshed: readonly string[];
  readonly removed: readonly string[];
  readonly errors: readonly { readonly kind: string; readonly projectId: string; readonly detail: string }[];
}

export type RefreshErrorProject = Pick<Project, 'id' | 'name' | 'rootPath' | 'aliasPaths' | 'prefixes'>;

export interface SelfErrorReport {
  /** `bd-refresh:<kind>` */
  readonly source: string;
  /** 伏せた detail (self-error-mask.ts)。 */
  readonly errorText: string;
  /** 報告したプロジェクトの name と rootPath (こちらは伏せない。公開本文にするときは 4y8q.2 の置き換えが別にかかる)。 */
  readonly project: { readonly name: string; readonly path: string };
}

export const REFRESH_ERROR_TRANSIENT_KINDS: readonly string[] = ['lock-contention', 'timeout'];
export const REFRESH_ERROR_TRANSIENT_THRESHOLD = 3;
/** 1 プロジェクトが覚えるキーの数。詳細に変わる値 (一時ファイル名など) が混ざっても、状態が増え続けないようにする。 */
export const REFRESH_ERROR_MAX_KEYS_PER_PROJECT = 20;
/** キーに入れる伏せた文の長さの上限 (UTF-16 コード単位)。超えたら先頭・長さ・末尾に畳む。throttle の 500 キーの記憶量を抑えるため。 */
const MAX_KEY_TEXT_LENGTH = 1024;

export interface RefreshErrorTrackerOptions {
  /** 既定は新しい throttle。ほかの本体エラーと報告の枠を共有したいときに渡す。 */
  readonly throttle?: SelfErrorThrottle;
}

export interface RefreshErrorTracker {
  /** 1 回のリフレッシュ結果ごとに呼ぶ。いま報告すべきエラーを `errors` の順に返す。 */
  observe(result: RefreshErrorInput, projects: readonly RefreshErrorProject[], now: Date): readonly SelfErrorReport[];
}

/** (kind, 伏せた detail)。別のプロジェクトの同じエラーは同じキーになる。 */
function keyOf(kind: string, errorText: string): string {
  const text =
    errorText.length > MAX_KEY_TEXT_LENGTH
      ? `${errorText.slice(0, 768)}…[${errorText.length}]…${errorText.slice(-256)}`
      : errorText;
  return `${kind}\n${text}`;
}

export function createRefreshErrorTracker(options: RefreshErrorTrackerOptions = {}): RefreshErrorTracker {
  const throttle = options.throttle ?? createSelfErrorThrottle();
  // プロジェクト → いま続いているキー → 連続して見えた回数。Map の挿入順を LRU に使う。
  const active = new Map<string, Map<string, number>>();

  /** throttle のキーは全プロジェクトで共有するので、どのプロジェクトにも無くなったときだけ忘れる (まだ続いている側を再報告で荒らさない)。 */
  function releaseKey(key: string): void {
    for (const keys of active.values()) if (keys.has(key)) return;
    throttle.forget(key);
  }

  function dropProject(projectId: string): void {
    const keys = active.get(projectId);
    if (keys === undefined) return;
    active.delete(projectId);
    for (const key of keys.keys()) releaseKey(key);
  }

  /** 見えた回数を 1 増やして返す (閾値で頭打ち)。 */
  function see(projectId: string, key: string): number {
    let keys = active.get(projectId);
    if (keys === undefined) {
      keys = new Map();
      active.set(projectId, keys);
    }
    const streak = Math.min((keys.get(key) ?? 0) + 1, REFRESH_ERROR_TRANSIENT_THRESHOLD);
    keys.delete(key);
    keys.set(key, streak);
    if (keys.size > REFRESH_ERROR_MAX_KEYS_PER_PROJECT) {
      const oldest = keys.keys().next().value;
      if (oldest !== undefined) {
        keys.delete(oldest);
        releaseKey(oldest);
      }
    }
    return streak;
  }

  return {
    observe(result, projects, now) {
      const projectById = new Map(projects.map((project) => [project.id, project]));
      const mask = createSelfErrorMasker(projects);
      for (const id of result.removed) dropProject(id);

      const reports: SelfErrorReport[] = [];
      const seenByProject = new Map<string, Set<string>>();
      const reportedKeys = new Set<string>();
      for (const error of result.errors) {
        // 名前もパスも分からない (伏せられない) プロジェクトのエラーは、報告しない・覚えない。
        const project = projectById.get(error.projectId);
        if (project === undefined) continue;
        const errorText = mask(error.detail);
        const key = keyOf(error.kind, errorText);
        const seen = seenByProject.get(project.id) ?? new Set<string>();
        seenByProject.set(project.id, seen);
        // 1 回の結果の中の同じキーは 1 回と数える。
        if (seen.has(key)) continue;
        seen.add(key);

        // refreshed に入っていなくても (fingerprint の失敗・listAll の失敗)、errors に出たものは「見えた」。
        const streak = see(project.id, key);
        const threshold = REFRESH_ERROR_TRANSIENT_KINDS.includes(error.kind) ? REFRESH_ERROR_TRANSIENT_THRESHOLD : 1;
        // 閾値に届かない間は throttle に聞かない (聞くと報告済みになり、3 回目の報告が間引かれる)。
        if (streak < threshold || reportedKeys.has(key) || !throttle.shouldReport(key, now)) continue;
        reportedKeys.add(key);
        reports.push({
          source: `bd-refresh:${error.kind}`,
          errorText,
          project: { name: project.name, path: project.rootPath },
        });
      }

      // 解消: refreshed に入っているのに errors に無いキーだけ。refreshed に入っていないプロジェクトの状態は変えない。
      for (const id of result.refreshed) {
        const keys = active.get(id);
        if (keys === undefined) continue;
        const current = seenByProject.get(id);
        for (const key of [...keys.keys()]) {
          if (current?.has(key) === true) continue;
          keys.delete(key);
          releaseKey(key);
        }
        if (keys.size === 0) active.delete(id);
      }
      return reports;
    },
  };
}
