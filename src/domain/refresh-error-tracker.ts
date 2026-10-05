/**
 * リフレッシュ (画面の自動更新) の失敗を、下書きにする価値のある報告へ絞る (bdboard-4y8q.6.2)。
 *
 * 入力は `refreshProjects` の結果と同じ形 (application 層の型は domain から import できないので、構造的な型を自分で宣言する)。
 * 同じエラーが更新のたびに出続けても報告は 1 時間に 1 回 (間引きは self-error-throttle.ts)。lock-contention と timeout は
 * 一時的なことが多いので 3 回続けて見えたら初めて報告する。配線 (下書きサービスの呼び出し) は 4y8q.6.3。
 */
import { normalizeErrorText } from './issue-draft.js';
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

/**
 * (kind, 伏せた detail を下書きの指紋と同じ normalizeErrorText で寄せたもの)。数字・時刻・16 進の断片だけが違う同じエラーは同じキーになる
 * (bd の Dolt サーバーのポートはプロジェクトごとに違う: `dolt server unreachable at 127.0.0.1:60995`)。寄せないと、別のプロジェクトの
 * 同じエラーが別々に報告され、実行ごとに変わる値 (時刻・経過時間・pid) を含む文は更新のたびに「初めて」になって間引きも 3 回の閾値も効かない。
 * 報告の errorText は寄せる前の伏せた文のまま (読み手に見せる文を変えない)。
 */
export function selfErrorKey(kind: string, errorText: string): string {
  const normalized = normalizeErrorText(errorText);
  const text =
    normalized.length > MAX_KEY_TEXT_LENGTH
      ? `${normalized.slice(0, 768)}…[${normalized.length}]…${normalized.slice(-256)}`
      : normalized;
  return `${kind}\n${text}`;
}

export function createRefreshErrorTracker(options: RefreshErrorTrackerOptions = {}): RefreshErrorTracker {
  const throttle = options.throttle ?? createSelfErrorThrottle();
  // プロジェクト → いま続いているキー → 連続して見えた回数。Map の挿入順を LRU に使う。
  const active = new Map<string, Map<string, number>>();

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
      if (oldest !== undefined) keys.delete(oldest);
    }
    return streak;
  }

  return {
    observe(result, projects, now) {
      const projectById = new Map(projects.map((project) => [project.id, project]));
      // 伏せる正規表現は一覧の大きさに比例して作るので、エラーがあるときだけ作る (更新のたびに走る。エラーの無い更新が大半)。
      let mask: ((text: string) => string) | undefined;
      // removed と、一覧に無くなったプロジェクト (一度もキャッシュされないまま探索から消えたものは removed に出ない) の状態を捨てる。
      // throttle の記録 (1 時間に 1 回) は消さない: 消えたり出たりするエラーが、そのたびに報告されないようにするため。
      for (const id of result.removed) active.delete(id);
      for (const id of [...active.keys()]) if (!projectById.has(id)) active.delete(id);

      const reports: SelfErrorReport[] = [];
      const seenByProject = new Map<string, Set<string>>();
      const reportedKeys = new Set<string>();
      for (const error of result.errors) {
        // 名前もパスも分からない (伏せられない) プロジェクトのエラーは、報告しない・覚えない。
        const project = projectById.get(error.projectId);
        if (project === undefined) continue;
        mask ??= createSelfErrorMasker(projects);
        const errorText = mask(error.detail);
        const key = selfErrorKey(error.kind, errorText);
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

      // 解消: refreshed に入っているのに errors に無いキーだけ、「続けて見えた回数」を 0 に戻す (throttle の記録は残す)。
      // refreshed に入っていないプロジェクトの状態は変えない。
      for (const id of result.refreshed) {
        const keys = active.get(id);
        if (keys === undefined) continue;
        const current = seenByProject.get(id);
        for (const key of [...keys.keys()]) {
          if (current?.has(key) === true) continue;
          keys.delete(key);
        }
        if (keys.size === 0) active.delete(id);
      }
      return reports;
    },
  };
}
