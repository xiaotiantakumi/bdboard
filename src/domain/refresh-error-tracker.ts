/**
 * リフレッシュ (画面の自動更新) の失敗を、下書きにする価値のある報告へ絞る (bdboard-4y8q.6.2)。
 *
 * 入力は `refreshProjects` の結果と同じ形 (application 層の型は domain から import できないので、構造的な型を自分で宣言する)。
 * 同じエラーが更新のたびに出続けても報告は 1 時間に 1 回 (間引きは self-error-throttle.ts)。決定的な種類 (REFRESH_ERROR_IMMEDIATE_KINDS)
 * 以外は、一時的なことがあるので 3 回続けて見えたら初めて報告する (bdboard-f2ob。以前は lock-contention と timeout だけだった)。
 * 3 回は、同じ文 (キー) の連続か、同じ kind の連続のどちらか早いほう。後者は、文が更新ごとにずれて寄らない失敗のため。
 * 報告の保存に失敗したら `release(report)` で返す (bdboard-4y8q.6.10): キーを throttle に忘れさせ、kind の連続の回 (ちょうど 3 回目か、その借りを返す回) に出した報告なら次にその kind が見えた結果を再び due にする。
 * 配線 (下書きサービスの呼び出し) は 4y8q.6.3。
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

/**
 * 1 回見えただけで報告する種類 (決定的な種類)。ここに無い kind (未知の文字列も) は、同じプロジェクトで同じ kind の失敗が
 * 連続 REFRESH_ERROR_TRANSIENT_THRESHOLD 回の結果に見えてから初めて報告する (文が更新ごとにずれても途切れない。下の observe)。
 *
 * 入れるのは、原因が bd の出力の中身で、誰かが直すまで何度読んでも同じ結果になる種類だけ。いまは schema-mismatch だけ。
 * - schema-mismatch: bd の出力 (JSON・日付・各欄) が期待の形でない。同じ出力は何度読んでも同じ形でない。
 *   未確認の懸念: bd が stdout にお知らせを出したときの `empty stdout` / `invalid JSON in stdout` も、この種類になる。
 *   それが一時的なものなら、この種類も 3 回の側に回すことになる。
 * 入れないもの (3 回続けて見えてから):
 * - lock-contention / timeout: 負荷や排他による一時的な失敗 (6.2 から)。
 * - not-a-beads-project: classifyBdError は出力に `beads directory` の部分文字列があるだけでこの種類にする。bd 1.2.1 の
 *   `failed to stat .beads directory: %w`、警告の `beads directory not set; credential encryption unavailable`、
 *   `workspace gate: empty beads directory` が当たる。`bd init` の最中なども一時的になりうるので、決定的とは言い切れない。
 * - bd-not-found: bd を起動できなかった。本当に bd が無いときは決定的だが、classifyBdError は exitCode -1 (シグナルでの終了や
 *   spawn の E2BIG など、起動後に起きたことも -1 に潰れる) もこの種類にする。`brew upgrade` で /opt/homebrew/bin/bd の symlink が
 *   張り替わる間は、一瞬 ENOENT にもなる。決定的とは言い切れない。
 * - unknown: どの種類にも当たらなかった残り。形の開いた集合で、起動直後の Dolt サーバーに繋がらない (connection refused) のように
 *   一時的な失敗が混ざる (bdboard-f2ob)。その形を 1 つずつ分類器に教えるのではなく、続いたかどうかで判定する
 *   (形を教えるたびに次の形で同じ誤報が出る — bdboard-xw00)。
 * 迷うなら入れない側に倒す: 決定的な失敗は 3 回続けて見えるのを待つだけ (既定の 5 分間隔で約 10 分、docs/ISSUE-REPORTING.md) で
 * 下書きは遅れるだけだが、一時的な失敗を 1 回で報告すると、利用者が見送る下書きが残る。
 */
export const REFRESH_ERROR_IMMEDIATE_KINDS: readonly string[] = ['schema-mismatch'];
/** 即時でない種類を報告するのに要る、同じ kind の連続回数。成功 (refreshed に入って errors にその kind が無い) を挟むと 0 に戻る。 */
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
  /**
   * `observe` が返した報告の保存に失敗したときに呼ぶ (bdboard-4y8q.6.10)。聞いたキーを throttle に忘れさせ、次の報告がもう一度保存に届くようにする。
   * 報告が「同じ kind の連続がちょうど 3 回になった回」(か、その借りを返す回) に出したものなら、キーを忘れるだけでは足りない (文が更新ごとにずれたり、
   * 別の文に変わったりすると、同じキーは二度と due にならず、連続が続く間は下書きが 1 件もできない。その回の文が同じキーの 3 回目でもあったときも同じ)。
   * そのときは、連続がまだ閾値のままなら、次にその kind が見えた結果を再び due にする。連続が数え直しになっていた (成功した更新を挟んだ) ときは、再び due にしない。この tracker が返していない報告・もう戻した報告は何もしない。
   */
  release(report: SelfErrorReport): void;
}

/** `observe` が返した報告が、どのキーを throttle に聞いて、何で due になったか。報告の形 (`SelfErrorReport`) は変えず、WeakMap で引く。 */
interface IssuedReport {
  readonly key: string;
  readonly projectId: string;
  readonly kind: string;
  /**
   * kind の連続の回 (ちょうど閾値に届いた結果か、借りを返す結果) に出した (決定的な種類を除く)。同じキーの連続でも due だったときも含む:
   * その回は連続に 1 回きりなので、保存に失敗したら、同じ文がもう出なくても連続が続く間に再び届くようにする。
   */
  readonly viaRun: boolean;
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
  // プロジェクト → kind → その kind の失敗が続けて見えた結果の数 (bdboard-f2ob)。キーと違い、文が更新ごとにずれても途切れない。
  const runs = new Map<string, Map<string, number>>();
  // プロジェクト → 「次にその kind が見えた結果で、再び due にする」kind (bdboard-4y8q.6.10)。kind の連続の回に出した報告の保存が失敗したときに足し、
  // その kind の報告を出す・連続が数え直しになる・プロジェクトが消える、のどれかで消す。
  const owed = new Map<string, Set<string>>();
  const issued = new WeakMap<SelfErrorReport, IssuedReport>();

  /** `owed` から kind を消し、空になったプロジェクトの Set も消す。 */
  function settle(projectId: string, kind: string): void {
    const kinds = owed.get(projectId);
    if (kinds === undefined) return;
    kinds.delete(kind);
    if (kinds.size === 0) owed.delete(projectId);
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
      if (oldest !== undefined) keys.delete(oldest);
    }
    return streak;
  }

  /** その kind の連続を 1 進める (結果 1 回につき 1 回だけ呼ぶ)。閾値にちょうど届いたこの回だけ true。 */
  function advanceRun(projectId: string, kind: string): boolean {
    const kinds = runs.get(projectId) ?? new Map<string, number>();
    runs.set(projectId, kinds);
    const before = kinds.get(kind) ?? 0;
    kinds.set(kind, Math.min(before + 1, REFRESH_ERROR_TRANSIENT_THRESHOLD));
    return before === REFRESH_ERROR_TRANSIENT_THRESHOLD - 1;
  }

  return {
    observe(result, projects, now) {
      const projectById = new Map(projects.map((project) => [project.id, project]));
      // 伏せる正規表現は一覧の大きさに比例して作るので、エラーがあるときだけ作る (更新のたびに走る。エラーの無い更新が大半)。
      let mask: ((text: string) => string) | undefined;
      // removed と、一覧に無くなったプロジェクト (一度もキャッシュされないまま探索から消えたものは removed に出ない) の状態を捨てる。
      // throttle の記録 (1 時間に 1 回) は消さない: 消えたり出たりするエラーが、そのたびに報告されないようにするため。
      for (const state of [active, runs, owed]) {
        for (const id of result.removed) state.delete(id);
        for (const id of [...state.keys()]) if (!projectById.has(id)) state.delete(id);
      }

      const reports: SelfErrorReport[] = [];
      const seenByProject = new Map<string, Set<string>>();
      const reportedKeys = new Set<string>();
      // プロジェクト → この結果で見えた kind → その kind の連続がこの回で閾値に届いたか。
      const runReachedByProject = new Map<string, Map<string, boolean>>();
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
        const reached = runReachedByProject.get(project.id) ?? new Map<string, boolean>();
        runReachedByProject.set(project.id, reached);
        // 保存に失敗した報告の借り (owed) があれば、連続が閾値のままでも「届いた回」として扱う (release)。advanceRun は借りの有無にかかわらず進める。
        if (!reached.has(error.kind)) reached.set(error.kind, advanceRun(project.id, error.kind) || owed.get(project.id)?.has(error.kind) === true);
        // 即時の種類は 1 回目から。ほかは、同じキーが 3 回続いた (以後 1 時間に 1 回) か、同じ kind の失敗が 3 回続いたちょうどその回 (か、その回の保存の失敗の借り)。
        // 後者は、文が更新ごとにずれて normalizeErrorText でも寄らない失敗 (Go の panic の pc=0x…、Dolt の base32 のハッシュ) を、続く間に 1 回は報告するため。
        const due =
          REFRESH_ERROR_IMMEDIATE_KINDS.includes(error.kind) ||
          streak >= REFRESH_ERROR_TRANSIENT_THRESHOLD ||
          reached.get(error.kind) === true;
        // 届かない間は throttle に聞かない (聞くと報告済みになり、3 回目の報告が間引かれる)。
        if (!due || reportedKeys.has(key) || !throttle.shouldReport(key, now)) continue;
        reportedKeys.add(key);
        const report: SelfErrorReport = {
          source: `bd-refresh:${error.kind}`,
          errorText,
          project: { name: project.name, path: project.rootPath },
        };
        issued.set(report, {
          key,
          projectId: project.id,
          kind: error.kind,
          viaRun: !REFRESH_ERROR_IMMEDIATE_KINDS.includes(error.kind) && reached.get(error.kind) === true,
        });
        // この kind の報告を出したので、借りは返した (この保存が失敗すれば release がもう一度足す)。
        settle(project.id, error.kind);
        reports.push(report);
      }

      // 解消: refreshed に入っているのに errors に無いキー・kind だけ、「続けて見えた回数」を 0 に戻す (throttle の記録は残す)。
      // refreshed に入っていないプロジェクトの状態は変えない。
      for (const id of result.refreshed) {
        const kinds = runs.get(id);
        const reachedKinds = runReachedByProject.get(id);
        for (const kind of [...(kinds?.keys() ?? [])]) if (reachedKinds?.has(kind) !== true) kinds?.delete(kind);
        if (kinds?.size === 0) runs.delete(id);
        // 連続が数え直しになった kind の借りは消す (成功した更新のあとの 2 回で、前の連続の保存失敗を理由に報告しない)。
        for (const kind of [...(owed.get(id) ?? [])]) if (runs.get(id)?.has(kind) !== true) settle(id, kind);
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
    release(report) {
      const meta = issued.get(report);
      if (meta === undefined) return;
      issued.delete(report);
      // 借りを先に足す (throttle の forget が throw しても、借りは残す)。連続がまだ閾値のままのときだけ:
      // 成功した更新を挟んで数え直しになっていたら、前の連続の失敗を理由に再び報告しない。
      if (meta.viaRun && runs.get(meta.projectId)?.get(meta.kind) === REFRESH_ERROR_TRANSIENT_THRESHOLD) {
        const kinds = owed.get(meta.projectId) ?? new Set<string>();
        kinds.add(meta.kind);
        owed.set(meta.projectId, kinds);
      }
      throttle.forget(meta.key);
    },
  };
}
