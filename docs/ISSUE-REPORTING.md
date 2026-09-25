# 不具合報告 — 全体設計

エピック bdboard-4y8q の「決めたこと」を前提に、子チケット
(bdboard-4y8q.1〜4y8q.10、bdboard-4y8q.12) が迷わない粒度まで仕様を詰めたもの。
本ドキュメントは **設計であり実装ではない**。実装は各子チケットが行い、本ドキュメントと
食い違いが出たら実装側の PR で子チケットの本文を更新する(bdboard-4y8q.11 受け入れ基準)。

対象読者は実装チケットの担当と、レビューするユーザー自身。用語は日本語、コードの型は
TypeScript 風の擬似コードで書く(実装の正確なシグネチャは各チケットが決める)。

## 0. スコープ外にしたもの

- UI のピクセル単位のレイアウトは bdboard-4y8q.3 の仕事。本ドキュメントは画面が消費する
  データの形(API の入出力)までを決める。
- `docs/GIT-WORKFLOW.md` の Closes/Refs 自動化(bdboard-4y8q.8)は別チケット。本ドキュメントは
  bd への取り込み時に `external-ref gh-<N>` を持たせるところまでを決める。
- 本物の GitHub API を叩く検証・実際の投稿は行わない(公開の書き込みなのでユーザー了承後)。

## 1. データモデル(項目 a)

下書き1件 = `data/issue-drafts/<id>/` 配下の `draft.json` + `images/` (2節で保存場所を決める)。
`id` は添付画像(`fs-attachment-storage.ts`)と同じ採番規約を流用する:
`${Date.now()}-${randomBytes(8).toString('hex')}`(例: `1758812345678-a1b2c3d4e5f6a7b8`)。
ソート可能・衝突耐性・パス構成要素として安全(`isSafePathSegment` 系のガードにそのまま通る)。

```ts
type DraftKind = 'A' | 'B' | 'C'; // A: 作業の進め方 / B: hook・配布スクリプト / C: bdboard本体
type DraftStatus = 'pending' | 'posted' | 'dismissed';

interface IssueDraft {
  readonly id: string;
  readonly kind: DraftKind;
  readonly fingerprint: string;           // 4節
  title: string;                          // 公開題名(編集可。初期値は5節の組み立て関数の出力)
  body: string;                           // 公開本文(編集可、同上)
  titleEditedByUser: boolean;             // true なら次の同一指紋マージ時も自動再生成しない
  bodyEditedByUser: boolean;
  readonly localOnly: LocalOnlyContext;   // 手元だけの生データ(公開本文には使わない。4/5節参照)
  readonly occurredProjects: readonly OccurredProject[]; // 発生したプロジェクトの一覧(手元限定)
  occurrenceCount: number;                // 回数
  readonly firstOccurredAt: string;       // ISO8601
  lastOccurredAt: string;
  status: DraftStatus;
  dismissReason?: string;                 // 見送りの理由(status='dismissed' のときのみ)
  issueNumber?: number;                   // 投稿後の GitHub issue 番号
  issueUrl?: string;
  sourceTicketRef?: string;               // harness-upstream 取り込み元のチケットID(4y8q.7)
  harnessVersionAtOccurrence?: string;    // A/Bのみ。注入先 .claude/bdboard-packs.json の version
  readonly draftSchemaVersion: 1;         // draft.json 自体のフォーマット版(将来の移行用)
}

interface LocalOnlyContext {
  readonly symptomRaw: string;
  readonly causeRaw: string;
  readonly preventionRaw: string;
  readonly errorTextRaw?: string;         // 切り詰め前の生ログ全文(手元限定・非公開)
  readonly errorTextHead?: string;        // 表示用に先頭 1000 文字へ切り詰めたもの(4節)
  readonly errorTextTail?: string;        // 表示用に末尾 1000 文字へ切り詰めたもの
  readonly errorTextTruncated: boolean;
  readonly agentNoteRaw?: string;         // 「新しく報告」で人/エージェントが書いた説明
  readonly envInfo: {
    bdboardVersion: string;
    harnessVersion?: string;
    os: string;
    nodeVersion: string;
    bdVersion?: string;
    ghVersion?: string;
  };
  readonly sourceTicketBody?: string;     // harness-upstream 元チケットの本文全体(公開しない)
}

interface OccurredProject {
  readonly name: string;                  // ディレクトリ名など(公開本文には出さない)
  readonly path: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}
```

「版」は本ドキュメントでは `harnessVersionAtOccurrence`(画面の「版の比較」用、4y8q.3 が最新版
=`harness/packs/bdboard-harness/pack.json` の `version` と並べて表示する)と解釈した。下書き
JSON 自体のフォーマット版が別途必要なら `draftSchemaVersion` を使う(すでに1で用意した)。

`localOnly` と `occurredProjects` という**オブジェクト自体**は5節の組み立て関数の入力型には
一切登場させない — `sourceTicketBody`(harness-upstream 元チケットの本文全体)のような
「絶対に公開してはいけない生データ」がうっかりまるごと入力に紛れ込む経路は、この型分離で
構造的に塞げる。ただし、これは「公開本文の元になる情報がすべて型でブロックされる」という
意味ではない点に注意(5節冒頭の同種の注記も参照)。`symptom`/`cause`/`prevention`/
`errorTextRaw` のような自由記述や、置き換え漏れ検出に使う `localProperNouns` の値そのものは、
5節の入力型に**意図して**含まれる(含めなければ本文も置き換えも作れない)。安全性を実際に
担保しているのは型分離そのものではなく、5節が定義する自動置換ルールと検出パスであり、
型分離が防ぐのは「そもそも意図されていない生データの混入」という別種の事故である。

## 2. 保存場所(項目 b)

**この節はチケット bdboard-727y(添付画像の保存先バグ)の結論待ち。** 727y は本ドキュメント
執筆時点でまだマージされていない。決めるのは「どこに置くか」ではなく「727y が実装する基点
解決関数をそのまま使う」という方針だけ:

- 既定パスは `<727y が決める共有状態ディレクトリの基点>/issue-drafts/<id>/`。
  添付画像が `<基点>/attachments/<projectKey>/<issueId>/` になるのと同じ基点関数を呼ぶ
  (関数名・シグネチャは 727y の実装に合わせる。bdboard-4y8q.1 は 727y に `DEPENDS ON` 済み)。
- 環境変数での上書きは `BDBOARD_ISSUE_DRAFTS_DIR`(`BDBOARD_ATTACHMENTS_DIR` と対称の名前)。
  `resolveAttachmentsDir` と同じ形の純粋関数 `resolveIssueDraftsDir(base, env)` にする。
- キャッシュ DB(`~/.bdboard/cache.db`)には置かない(エピック決定どおり)。
- git clone 環境の `data/` 配下に既存の `data/attachments` があるのと同様、
  `data/issue-drafts` も `.gitignore` 対象にする(727y の結論が `<repoRoot>/data/...` のままなら)。
- ディレクトリ作成時のパーミッションは `data/attachments` と同じ扱いに揃える(所有者のみ
  読み書き可、`0700`/`0600` 相当。下書きには4節で述べる `errorTextRaw`(手元限定・非公開の
  生ログ)が入るため、`data/attachments` より緩くしない)。

727y が「npm インストール環境ではホームの下に置く」という結論になった場合、issue-drafts も
無条件にそれへ追従する。本ドキュメントは 727y の具体的な結論を先取りしない
(そちらのチケットのスコープ)。

## 3. 受け口の API とローカル直アクセス限定(項目 c)

3つの経路があり、要求される認可の強さが異なる。

| 経路 | メソッド/パス | 呼び出し元 | 必要な認可 |
|---|---|---|---|
| 受け取り | `POST /api/issue-reports/drafts` | 各プロジェクトの `scripts/report-issue.sh`(4y8q.12)、bdboard 自身のエラー捕捉(4y8q.6) | **ローカル直アクセスのみ**(トンネル不可) |
| 閲覧・編集・見送り | `GET /api/issue-reports/drafts`、`GET .../:id`、`PATCH .../:id`、`PATCH .../:id/dismiss` | 不具合報告タブの UI | 通常の write-guard(ローカル直 または 強パスワード+セッション Cookie のトンネル) |
| 投稿 | `POST /api/issue-reports/drafts/:id/publish` | 不具合報告タブの投稿ボタン | **ローカル直アクセスのみ** |

エピック決定 4「投稿はローカル直アクセスからだけ。トンネル経由では、見る・直す・見送るまで」
と決定 5「受け口はローカル直アクセスからだけ」をそのまま2段の認可に落とした形。

### 「ローカル直アクセスだけに限る方法」

現状の `createWriteGuardMiddleware`(`evaluateWriteAccess`)は「ローカル直 **または**
強パスワード+有効なトンネルセッション Cookie」を許可に含む(`write-guard.ts` 128〜148行)。
受け取りと投稿の2経路はこれでは緩すぎる — ただし**新しい関数は要らない**。既存の
`createPrivilegedApiGuardMiddleware(deps)` は、渡す `deps` からトンネル関連のコールバック
(`isTunnelWriteAllowed`/`hasTunnelSession` 等)を丸ごと省略すると `evaluateWriteAccess` 内部で
トンネル分岐そのものが評価されず、`isLocalBasicAuthRequest(c)` 一発の判定にフェイルクローズ
する(CSRF チェックは維持したまま)。さらに `createWriteGuardMiddleware` と違い
**全 HTTP メソッドに適用される**ので、受け取り(POST)・投稿(POST)はもちろん、後述の
GET 系エンドポイントを同じ強さで塞ぎたい場合にも使い回せる。つまり:

```ts
const localOnlyGuard = createPrivilegedApiGuardMiddleware({}); // トンネル deps を渡さない
```

の1行を受け取り・投稿の2ルートへ前置するだけでよい。新しいミドルウェア関数を書き起こさない
(既存踏襲の precedent は `PUT /api/settings/agent-runs`(bdboard-54be.1)、
`POST/DELETE /api/tunnel/*` がすでにこの「`deps` を渡さない」形を使っている。
`GET /api/chat/availability` は当初このセクションで precedent として挙げていたが、実体は
チャット機能のレート制限スキップ判定であり局所アクセス限定ゲートではない
(`chat-agent-routes.ts:79`)。より正確な precedent は `chat-routes.ts:176〜184` 行の
「discovered sessions」ガードで、これもローカル直アクセスを別扱いする同種の判定である)。

### 閲覧・編集(PATCH)側のフィールド範囲

3節冒頭の表で「閲覧・編集・見送り」はトンネル経由(強パスワード+セッション Cookie)でも
許可しているが、これは「編集画面を使わせる」ためであって「任意のフィールドを書き換えて
よい」という意味ではない。`PATCH /api/issue-reports/drafts/:id` が受け付けるフィールドは
次に限定し、それ以外のキーを含むリクエストは 400 で拒否する:

- `title`、`body`、`titleEditedByUser`、`bodyEditedByUser`(いずれも公開前の編集用)
- `dismissReason`(`/dismiss` 経由。`status` を直接 `'dismissed'` に書き換えさせず、
  専用エンドポイント `PATCH .../:id/dismiss` に限定する)

`status`(`'posted'` への遷移)、`issueNumber`/`issueUrl`、`fingerprint`、`occurrenceCount`
等の集計・確定フィールドは PATCH の対象外とし、サーバー側(6節の投稿フロー、4節の受信処理)
だけが書き換える。トンネル経由の書き込みは強パスワードを要求するとはいえ、フィールドを
無制限にすると「見る・直す・見送るまで」というエピック決定4の意図を超えて `status='posted'`
相当の状態を外形的に作れてしまう余地が残るため、ここは型(許可フィールドの union)とサーバー
側バリデーションの両方で塞ぐ。

### なりすましの余地(判定の限界)

`isLocalBasicAuthRequest` は「TCP 送信元がループバック」かつ「Cloudflare トンネル転送ヘッダ
(`cf-connecting-ip`/`cf-ray`/`cf-visitor`)が無い」かつ「Host ヘッダが listen ポートと一致」の
3条件で判定する(`local-request.ts`。決定根拠は `docs/DECISIONS-LOG.md` [.137])。既知の限界:

- **前提は cloudflared の HTTP モードだけ。** この3条件は「cloudflared がループバックへ
  127.0.0.1 から接続し、かつ Cloudflare 転送ヘッダを必ず付ける」という cloudflared 固有の
  挙動に依存している。ユーザー自身が `ssh -L`/`ngrok`/`socat`/`kubectl port-forward` のような
  別のループバック終端プロキシを 8787 へ向けて構成した場合、転送ヘッダが付かないので
  「ローカル直アクセス」と誤判定されうる。これは write-guard の他エンドポイントと共有する
  既知の前提であり、本設計が新しく持ち込む穴ではない(bdboard が自分で提供するトンネル機構は
  cloudflared だけなので、脅威モデルとしてはそこまでで足りるという既存判断を踏襲する)。
- Host ヘッダ一致は DNS rebinding への追加防壁であって、それ単体で権限を与える根拠にはしない
  (`local-request.ts` のコメントどおり)。
- **「ローカル直アクセスのみ」は「人間が確認した」の代用にはならない。** この判定はあくまで
  「リクエストがどこから来たか」の判定であり、「誰が(何が)そのリクエストを送ったか」までは
  判定できない。ループバックから送られる `curl -X POST`(Sec-Fetch-Site/Origin ヘッダ無し、
  `Content-Type: application/json`)は3条件をすべて満たし「ローカル直アクセス」と判定される
  — 送信元がユーザー本人の操作か、ローカルで動く別プロセス(将来ローカル実行が許可される
  エージェントや、トンネル越しに指示されて動く手元スクリプト等)かをこのガードだけでは
  区別できない。エピック決定「確認なしの自動投稿は作らない」を本当に満たすには、この
  ネットワーク層の判定に加えて **投稿(6節)の最終手順そのものを人間の手操作でしか進められない
  形にする**必要がある。6節はこの前提で `gh issue create --web` を採用する。

## 4. 指紋・状態遷移・件数の上限(項目 d)

### 指紋の作り方

- **種類 A**: `fingerprint = "A:" + catalogSlug`(failure-catalog の短い名前をそのまま使う)。
- **種類 B/C**: 出どころ + 正規化したエラー文から作る:

```ts
function normalizeErrorText(text: string): string {
  return text
    .replace(/\/(Users|home)\/[^\s'"]+/g, '<path>')
    .replace(/~\/[^\s'"]*/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')          // hex/uuid 断片
    .replace(/:\d+:\d+\b/g, ':<loc>:<loc>')          // line:col
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, '<time>') // ISO timestamp
    .replace(/\d+/g, '<n>')
    .toLowerCase()
    .trim();
}
// fingerprint = "B:" + source + ":" + sha256(normalizeErrorText(text)).slice(0, 16)
// source は hook 名・スクリプト名・API のパスなど「出どころ」の識別子
```

正規化は best-effort(項目 e の置き換え漏れ検出と同じく、完全性を保証しない)。目的は
「同じ症状を同じ1件にまとめる」ことであり、公開本文の安全性はここではなく5節が担う。

### 状態遷移(bdboard-4y8q.1 が実装するのは pending/dismissed だけ、posted 側は 4y8q.5)

| 受信した指紋の状態 | 動作 |
|---|---|
| 既存の下書きなし | 新規作成、`status='pending'`、`occurrenceCount=1` |
| `pending` の下書きあり | 新規作成しない。`occurrenceCount+=1`、`lastOccurredAt` 更新、`occurredProjects` に無ければ追加。`titleEditedByUser`/`bodyEditedByUser` が false なら5節の関数で `title`/`body` を再生成(件数・最終発生時刻の反映) |
| `dismissed` の下書きあり | 新規作成しない。`occurrenceCount+=1` のみ(エピック決定どおり) |
| `posted` かつ issue が open(4y8q.5) | 新規作成しない。「その後 N 回起きた」を表示、issue へコメントを足すボタンを出す |
| `posted` かつ issue が closed(4y8q.5) | 「再発(#N は閉じ済み)」として新規下書きを作る |

### 上限

- 1件のテキストサイズ: 手元保存の `errorTextRaw` 自体にも上限を設ける(64KB。超過分は
  末尾から切り詰める)。表示用の `errorTextHead`/`errorTextTail`(各 1000 文字、
  `"…(N 文字省略)…"` を間に挟む)は **この `errorTextRaw` から作る派生値であり、
  5節の置き換え(トークン等の自動置換)は `errorTextRaw` の全文に対して先に適用してから
  1000文字へ切り詰める。** 順序を逆にする(先に1000文字へ切り詰めてから置換する)と、
  トークンが切り詰め境界でちょうど分断され、置換の正規表現(20文字以上を要求するものが
  多い)にマッチしなくなり、断片が置換されないまま公開本文に残る恐れがある。`draft.json`
  全体(画像を除く)は 200KB を上限とし、超過分は末尾から切り詰める(添付画像は別ファイル
  なので影響しない)。
- 画像: 添付画像 API と同じ検査を流用 — マジックバイト判定、1枚 10MB、1下書きあたり
  20枚まで(`ATTACHMENT_MAX_BYTES`/`ATTACHMENT_MAX_COUNT_PER_TICKET` と同じ定数を共有するか、
  `issue-report` 用に複製して同じ値を持たせる)。
- 新規下書きの件数: **1時間20件まで**。実装は UTC の暦時間バケツ
  (`mass-occurrence:<kind>:<yyyy-mm-ddTHH>`)で数える。21件目以降の新規指紋は個別の下書きを
  作らず、そのバケツの「大量発生」下書きへ丸め込む(`occurrenceCount` を増やし、`localOnly` に
  丸め込まれた元の指紋一覧を追記する。公開本文は「この時間に N 件の類似しない問題が集中発生」
  という一般的な文面に留め、個別の詳細は出さない)。暦時間区切りは実装が簡単な分、境界をまたぐ
  瞬間だけ実質的な上限が緩む(60分の壁時計窓ではなく1時間区切り)。厳密なスライディングウィンドウ
  が要るなら実装時に変更してよい(小さな決め事なので本ドキュメントではブロックしない)。

## 5. 公開本文の組み立てと置き換え(項目 e、bdboard-4y8q.2)

`domain` 層の純粋関数。入力の型そのものに `localOnly`/`occurredProjects` オブジェクトを
含めないことで、それらの**まるごとの混入**を型で塞ぐ(4y8q.2 の要求。1節末尾の注記も参照)。
自由記述(`symptom`/`cause`/`prevention`/`errorTextRaw`)は意図して入力に含まれており、
これらに残りうる固有名詞・秘密情報を実際に取り除くのは以下の置き換え規則の役目であって、
型そのものが担保するわけではない。

```ts
type ProperNounCategory = 'project' | 'user' | 'host' | 'branch';
interface LocalProperNoun {
  readonly category: ProperNounCategory;
  readonly value: string;                 // 4文字未満は対象外(呼び出し側でフィルタ済みを渡す)
}

interface PublicBuildInput {
  readonly kind: DraftKind;
  readonly catalogSlug?: string;          // A のみ
  readonly ruleOrScriptName?: string;     // B/C の出どころ
  readonly symptom: string;
  readonly cause: string;
  readonly prevention: string;
  readonly errorTextRaw?: string;         // 切り詰め前の生ログ全文(4節)。置換はこの全文に対して行う
  readonly agentNote?: string;            // 「新しく報告」の説明文もここを通す(要求どおり)
  readonly versions: {
    bdboardVersion: string;
    harnessVersion?: string;
    os: string;
    nodeVersion: string;
    bdVersion?: string;
    ghVersion?: string;
  };
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  // 自動置換と置き換え漏れ検出の両方に使う、公開してはいけない固有名詞のリスト
  readonly localProperNouns: readonly LocalProperNoun[];
  // category='project' のうち、パスとして解決できるもの(occurredProjects[].path 由来)。
  // パス丸ごとの置換に使う(下の置き換え規則1)。
  readonly localProjectPaths: readonly string[];
}

interface RedactionMark { readonly kind: string; readonly start: number; readonly end: number; }
interface SuspectedLeak { readonly term: string; readonly index: number; }

interface PublicBuildResult {
  readonly title: string;
  readonly body: string;
  readonly redactions: readonly RedactionMark[];   // 画面で印を付けるための位置
  readonly suspectedLeaks: readonly SuspectedLeak[]; // 置き換え漏れの疑い
}

// 置換パスと検出パスを分離しておく(単体テストしやすくするため、4y8q.2 実装時はこの2つを
// 別の内部関数として書き、buildPublicIssueBody はその合成にする)。
function applyRedactions(text: string, input: PublicBuildInput): { text: string; marks: RedactionMark[] };
function detectSuspectedLeaks(text: string, nouns: readonly LocalProperNoun[]): SuspectedLeak[];
function buildPublicIssueBody(input: PublicBuildInput): PublicBuildResult;
```

### 置き換え規則(自動置換、この順序で適用する)

**エラー全文(`errorTextRaw`)に対しては、この置換をすべて適用してから1000文字の先頭/末尾へ
切り詰める(4節参照)。先に切り詰めるとトークンが境界で分断され、正規表現にマッチしなくなる
ため順序を守る。**

1. `localProjectPaths` に含まれる絶対パス(プロジェクトルート)→ そのパス丸ごと `<project>`。
   **他のどの置換よりも先に行う**(後述の2でホームディレクトリを先に `~` へ置換すると、
   プロジェクトルートの絶対パスの文字列が変化してこの規則が一致しなくなり、
   `~/path/to/<project名>` のような形でプロジェクト名だけが残ってしまうため)。
2. ホームディレクトリの絶対パス(1で置換されず残っている分)→ `~`
3. `localProperNouns` の各値(`project` を含む全カテゴリ、大小文字区別なしの部分一致)→
   カテゴリに応じて `<project>`/`<user>`/`<host>`/`<branch>`。1・2はパスの形をした言及を
   拾うためのもので、この3はプローズ中の言及(例: 文中に生の名前がそのまま書かれている場合)
   を拾う。
4. トークンらしい文字列 → `<redacted-token>`(以下は代表的なパターンであり、
   **網羅的な一覧ではない** — 実装時に各サービスの最新の鍵書式を追加してよい。設計文書として
   ここで確定させるのは「自動置換の仕組みを持つこと」と「最低限このカテゴリは拾うこと」まで)
   - GitHub: `gh[pousr]_[A-Za-z0-9]{20,}` / `github_pat_[A-Za-z0-9_]{20,}`
   - OpenAI: `sk-[A-Za-z0-9]{20,}`
   - Anthropic: `sk-ant-[A-Za-z0-9_-]{20,}`
   - AWS アクセスキー: `AKIA[0-9A-Z]{16}`
   - Slack トークン: `xox[baprs]-[A-Za-z0-9-]{10,}`
   - 秘密鍵ブロック: `-----BEGIN [A-Z ]*PRIVATE KEY-----` から対応する `-----END` 行までを
     丸ごと `<redacted-key-block>` に置換
   - 上記は自動置換。それ以外の「32文字以上の英数記号の塊」は誤検知(コミットハッシュ等)が
     多いため自動置換せず、次項の「置き換え漏れの疑い」側で警告に留める。
5. メールアドレス(`[\w.+-]+@[\w-]+\.[\w.-]+`)→ `<email>`

### 置き換え漏れの検出(疑いのフラグ、判断はしない)

上の1〜5をすべて適用**後**の本文に対し、`localProperNouns` を大小文字区別なしの部分一致で
再走査する。3の自動置換が正しく効いていれば通常はヒットしないはずだが、正規表現の
エスケープ漏れや文字種の違いなど実装バグの検知にもなるため、独立した最後の網として残す。
ヒットしたら `suspectedLeaks` に積む。これは best-effort であり、唯一の防御にはしない
(エピック決定どおり「投稿の前に毎回人が見る」が本来の防御)。

### プレビュー表示時の注意(画像・リンクの自動読み込み)

不具合報告タブ(4y8q.3)の下書き編集画面、外部 issue 判定画面(4y8q.9/4y8q.10)のどちらも、
本文を markdown プレビューとして描画する。この本文には(自分の下書きなら)エラーメッセージに
偶然含まれる URL、(外部 issue なら)攻撃者が意図的に仕込んだ markdown 画像記法
(`![](https://attacker.example/pixel.png?...)`)が入りうる。プレビューを素朴に
markdown→HTML 変換して画像を自動読み込みすると、**人間がまだ何も確認・投稿していない
時点で外部への GET リクエストが飛び**、下書きの存在やタイミングを外部へ知らせてしまう
(トラッキングピクセル)。実装要件として: プレビュー描画は画像・外部リンクの自動フェッチを
行わない(markdown 画像記法はリンクテキストとして表示するに留めるか、明示的な
「画像を読み込む」ボタンを挟む)。この要件は4y8q.3・4y8q.9 の両方の受け入れ基準に含める。

### 実例での確認(4y8q.2 の受け入れ基準)

PicRill-fbs の本文(作業フォルダ名・ポート番号・プロジェクト名入りのエラー文)を材料に、
`buildPublicIssueBody` を通した結果に固有名詞が残らないことをテストで確認する。実例の文面
そのものはテストに書き込まない(CLAUDE.md の example-user 規約と同じ理由 — 値そのものを
リポジトリに残さない)。

## 6. 投稿(項目 f、bdboard-4y8q.4)

`POST /api/issue-reports/drafts/:id/publish`(3節の認可)。

### 実際の投稿操作はブラウザに委ねる(Opus レビュー Blocker B1 への対応)

3節で述べたとおり「ローカル直アクセスのみ」というネットワーク層の判定だけでは、
「人間が実際に確認して投稿した」ことを保証できない(`curl` 一発で同じガードを通過できる)。
エピック決定「確認なしの自動投稿は作らない」を構造的に満たすため、**実際に GitHub へ issue を
作る操作は `gh issue create --web`/`gh issue comment --web` に委ね、投稿ボタンの押下は
「ブラウザを開くところまで」に留める。** `--web` はローカルの既定ブラウザで GitHub の
「New issue」フォームを開くだけで、実際の作成(GitHub 側の "Submit new issue" ボタン)は
その後ユーザーが実物のブラウザ上で行う。bdboard サーバープロセスや、それを叩く何らかの
ローカルプロセスが単独で issue を作り切ることが構造的にできなくなる(この設計はトンネル越しに
動く可能性のあるチャットエージェント等からのエスカレーション経路も同時に塞ぐ — 道具を
持つエージェントがこの API を叩けても、ブラウザでの人間の最終クリックまでは issue が
実在しない)。

手順:

1. ガード: `isLocalBasicAuthRequest` でなければ 403 + 画面はボタンを出さない(理由を表示)。
   このガードはブラウザを開く操作自体(GitHub 側のセッションで何が見えるか)をローカル外から
   起動されないようにする目的で維持する。
2. `gh --version`/`gh auth status` を確認(`gh` 自体が無い、または未ログインなら 424 相当で
   案内を返す。check-gh-issues.mjs の `failureReason` と同じ「落ちずに理由を返す」流儀)。
   `--web` は GitHub 側のブラウザセッション(cookie)で認証されるため `gh auth status` は
   厳密には投稿自体の必須条件ではないが、後述の類似 issue 検索(読み取り専用 API)には
   引き続き `gh` の認証が要る。
3. 似た issue の検索(投稿前に必ず1回、読み取り専用 API なのでこの手順は従来どおり):
   `gh issue list --repo xiaotiantakumi/bdboard --search "<title の主要語 or catalogSlug>"
   --state all --json number,title,state --limit 10`。この検索は7節(評価エージェントへ渡す
   類似チケット探し)と共通の `findSimilarIssuesAndTickets(query)` ヘルパーに集約し、
   4y8q.4 と 4y8q.10 の両方から呼ぶ(別々に実装しない)。
4. ユーザーが「新規」か「既存 issue にコメント」かを選ぶ(画面側)。コメント本文も5節の
   `buildPublicIssueBody` 相当の置き換えを通す。
5. 本文は一時ファイル経由で `gh` に渡す(`gh issue create --repo xiaotiantakumi/bdboard
   --title "<title>" --body-file <tmp> --web` / `gh issue comment <N> --repo
   xiaotiantakumi/bdboard --body-file <tmp> --web`)。コマンド置換で直接埋め込まない —
   添付画像 API の教訓(question-template.md、ARG_MAX とシェルインジェクション)をそのまま
   踏襲する。`execFile` 系(シェルを経由しない実行)を使う点も同様。
6. **本文が長い場合の扱い(URL 長の制約)**: `--web` は本文をブラウザへ渡す際に URL の
   クエリパラメータとして組み立てるため、GitHub 側・ブラウザ側の URL 長制限にかかりうる
   (数千文字程度が実務上の目安。正確な閾値は実装時に確認する)。本文が閾値を超える場合は、
   プレフィル本文を「先頭の要約 + "本文が長いため一部省略。続きは下の欄からコピーして
   ブラウザ側に貼り足してください"」に切り詰め、画面側に全文コピー用のテキストエリアを
   別途表示する(4y8q.3/4y8q.4 の実装事項。エラー全文を短く保つ4節の 1000 文字上限は
   この閾値に収まることを狙った設計でもある)。
7. サーバーは `--web` を起動した時点では投稿の成否を知らない(ブラウザでの実際の送信は
   非同期にユーザーが行うため)。画面は「ブラウザでの投稿が終わったら、issue の URL を
   貼り付けてください」という入力欄を出す。ユーザーが URL(または `#<N>`)を貼ると、
   サーバーは `gh issue view <N> --repo xiaotiantakumi/bdboard --json number,url,state`
   で実在確認したうえで `status='posted'`、`issueNumber`/`issueUrl` を保存する。空欄のまま
   閉じることもでき、その場合は下書きを `pending` のまま残す(取りこぼしても二重投稿には
   ならない — 3節の似た issue 検索が次回の重複防止を担う)。
8. URL 確認(手順7)が完了した直後、`sourceTicketRef` があれば(4y8q.7 由来)、
   元プロジェクトの bd チケットへ `bd comment <ref> "issue: <url>"` → `bd close <ref>` を
   実行する。
9. gh 呼び出しはすべて `--repo xiaotiantakumi/bdboard` を明示し(実行時の `cwd` の git
   remote に依存しない)、非対話実行であることを保証するため環境変数
   `GH_PROMPT_DISABLED=1` を付ける。新しいポート `IssuePublisherPort`
   (`createGhCliIssuePublisher`)経由にし、`infrastructure/gh/` に置く(`child_process` は
   `infrastructure/process`/`infrastructure/runners` からしか import できないルールに
   合わせ、既存の `createGhCliPrStatusReader` と同じ置き場にする)。

テストでは `gh` 呼び出しを偽物(fake `CommandRunner`)に置き換え、本物のブラウザや issue は
一切起動・作成しない(4y8q.4 の受け入れ基準どおり)。

## 7. bd への取り込み(項目 g、bdboard-4y8q.4 の一部)

「bdboard 自身の bd が使える環境(メンテナ環境)」の判定は、bdboard がスキャンしている
どれかのプロジェクトの話ではなく、**bdboard サーバー自身の `repoRoot` に `.beads/` が
存在するか**で判定する(`isMaintainerEnvironment(repoRoot) = fs.existsSync(path.join(repoRoot,
'.beads'))`)。npm でインストールした環境ではこれが存在せず、投稿だけで終わる。

投稿(6節)が成功した直後、メンテナ環境なら追加で:

```
bd create --type=<下表参照> --priority=2 \
  --external-ref gh-<N> --title "<title>" \
  --description "<localOnly の要点 + issue URL>"
bd label add <新id> harness   # A と B のみ
```

| 種類 | `--type` | `harness` ラベル |
|---|---|---|
| A(作業の進め方) | `task` | 付ける |
| B(hook/配布スクリプト) | `bug` | 付ける |
| C(bdboard本体) | `bug` | 付けない |

優先度は既定 `P2`(エピック決定どおり)。`description` には `localOnly` の生データ(エラー全文・
プロジェクト名・パス)を入れてよい(bd は非公開のため)。

**ただしこの `localOnly` の生データは bd チケットの中だけに留める。** 実装時にこのチケットを
着手する人間・エージェントは、`description` の内容をそのまま PR 本文・コミットメッセージ・
公開 issue へのコメントへ転記しない。bd チケットは非公開だが、PR・コミット・GitHub issue は
すべて公開(`xiaotiantakumi/bdboard` は public リポジトリ)であり、`localOnly` にはプロジェクト
名・絶対パス・ユーザー名などエピックが最初から「公開しない」と決めた情報がそのまま入って
いるため、無自覚なコピペで5節の置き換えを経由せずに公開へ漏れる経路になりうる
(S11。ここは `docs/GIT-WORKFLOW.md` 側のコミット規約に一文追加することを7節実装の
受け入れ基準に含める)。

`npm run check:gh-issues`(`scripts/check-gh-issues.mjs`)は open issue のうち bd の
`external_ref` に `gh-<N>` を持たないものを検出するスクリプト。ここで作る bd チケットが
`external-ref gh-<N>` を持つことで、投稿直後から `check:gh-issues` の「未紐付け」判定から
外れる — 別途の同期処理は要らない(既存スクリプトを変更しない)。

## 8. 外部 issue の判定経路(項目 h、bdboard-4y8q.9 / 4y8q.10)

### 機械の検査(4y8q.9、判断を含まない)

| 検査 | 内容 |
|---|---|
| 見えない文字 | 幅ゼロ文字(U+200B/200C/200D/FEFF/2060)、双方向制御文字(U+202A–202E、U+2066–2069。いわゆる Trojan Source 系) |
| HTML コメント | `<!--...-->`(GitHub の markdown レンダリングでは非表示だが生の本文には残る) |
| 長い符号化文字列 | base64 らしい文字集合が 200 文字以上連続する箇所 |
| リンクの数 | markdown リンクと生 URL の合計数 |

結果はカードに出すだけで安全/危険の判断はしない(4y8q.9 の要求)。判定時点の本文と
`updatedAt` をスナップショットとして保存し、GitHub 側の生の `body`/`updatedAt` と食い違ったら
「再判定が必要」の印を付ける。

**取り込み対象の GitHub issue は他人が書いた任意長のテキストであり、下書き(4節)のような
自前の上限が最初から効いていない。** 機械の検査・2体のエージェントへ渡す前に、サーバー側で
`title` は 300 文字、`body` は 20,000 文字を上限に切り詰める(超過分は末尾を落とし
「(本文が長いため以降省略)」を付す)。この上限は主にコスト・処理時間の制御が目的で、
安全性は元々「道具ゼロ」(下のエージェント設計)と「人間の最終確認」が担っており、
切り詰めそのものはセキュリティ境界ではない。

### 2体のエージェント(4y8q.10)

道具ゼロで呼ぶ手段は、bdboard に既にある `ChatAgentPort`(`claude-chat-agent.ts`)の CLI 起動
インフラを流用しつつ、ツール面だけ最小化した専用スペックを新設する。CLI 引数の組み立ては
`build-claude-args.ts`(Runner 用、`--allowedTools`/`--disallowedTools` はどちらも空配列を渡すと
フラグ自体を省略し CLI 既定にフォールバックする)を流用せず、同じチャット系インフラ内の
`src/infrastructure/chat/specs/claude-spec/args.ts` がすでに使っている「許可制」の組み方を
道具ゼロ向けに適用する:

- `--tools ''` を渡してベースのツール集合そのものを空にする。`--disallowedTools` による
  拒否リスト方式(当初案)は「将来 CLI に追加される未知のツールは拒否リストに載っていないので
  素通りする」という denylist 特有の穴を持つため採用しない。`--tools ''` は allowlist 方式
  (何も許可しない)であり、この穴が構造的に無い。
- `--strict-mcp-config` を渡し、`--mcp-config` は省略する(または `{"mcpServers":{}}`)。
  MCP サーバー(`bd-mcp-server` 等)を一切アタッチしない。
- `--setting-sources ''` を渡し、プロジェクト/ユーザーの CLAUDE.md・settings.json 経由で
  追加のツール許可やフックが差し込まれる経路を断つ。
- `--allowedTools` は渡さない(`--tools ''` がすでにベースをゼロにしているため、
  `--allowedTools` で個別に足し戻すことがなければ道具は増えない)。
- 実行時の `cwd` はリポジトリと無関係な空の一時ディレクトリに固定する(万一ツールがすり抜けても
  壊せる対象が無いようにする、多層防御)。
- 環境変数は allowlist(モデル呼び出しに必要な認証情報のみ)。Runner の3層最小化
  (ARCHITECTURE.md「エージェントに与える権限は最小化する」節)と同じ考え方を、道具ゼロの
  ケースに適用したもの。

**未決**: 上の組み合わせ(`--tools ''` + `--strict-mcp-config` + `--setting-sources ''`)が
実際に道具ゼロを達成しているかは、ARCHITECTURE.md 自身が言う「CLI を上げたら測り直す」と
同じ理由で実測が要る。実装時に隔離ディレクトリでこの組み合わせを実行し、書き込み・
ネットワーク系の指示を与えても実行されないことを確認してから確定する。

安全判定(1体目)と⭐評価(2体目)は入力・出力とも独立:

```ts
// 1体目: 安全判定
interface SafetyJudgeInput {
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly machineCheck: MachineCheckResult;
}
type SafetyVerdict =
  | { readonly verdict: 'safe' | 'caution' | 'danger'; readonly reason: string };

// 2体目: 5段階評価(verdict === 'safe' のときだけ呼ぶ。別プロセス/別呼び出し)
interface EvaluationInput {
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly machineCheck: MachineCheckResult;
  readonly similarTitles: readonly string[]; // findSimilarIssuesAndTickets() の結果(題名のみ)
}
interface EvaluationResult {
  readonly stars: 1 | 2 | 3 | 4 | 5;
  readonly reason: string;
}
```

サーバーは両方の出力を厳密な JSON スキーマで検証する。パースに失敗するか型が合わなければ
「判定失敗」として扱い、取り込みボタンは押せない(エピック決定どおり)。

| ⭐ | 表示 | 取り込み時の bd 優先度(自動上限) |
|---|---|---|
| ★★★★★ | 優先的に対応すべき | **P2**(P1 への昇格は人間の明示操作でのみ。5節と同じ理由 — エージェントの出力を無条件に最上位優先度へは直結させない) |
| ★★★★☆ | 対応推奨 | P2 |
| ★★★☆☆ | 余裕があれば | P3 |
| ★★☆☆☆ | 様子見 | P4 |
| ★☆☆☆☆ | 対応不要(重複・対象外・情報不足) | 取り込み非推奨(ボタン自体は出す) |

取り込みボタンは「safe かつ評価が揃っている」ときだけ活性化する。GitHub 側で本文が編集され
スナップショットと食い違ったら、再判定が終わるまで非活性に戻す。この「食い違い検知」自体は
GitHub からの読み取り専用フェッチ(安価)だが、**エージェントの再呼び出しは人間が「再判定」
ボタンを押したときだけ行う**(自動ポーリングやページ表示のたびには呼ばない)。外部の第三者が
issue 本文を繰り返し編集するだけでは道具ゼロエージェントの呼び出し回数を増やせない
ようにするための境界であり、コスト・DoS 対策を兼ねる。`danger` のときはボタンを出さず
「再判定」ボタンだけ出す。それでも取り込みたい場合は人が自分の言葉でチケットを書く
(外部本文をそのまま bd へ写す経路は用意しない)。

**取り込み後の bd チケットには `external-untrusted` ラベルを付け、`bd ready` の既定表示と
Runner の自動着手対象から外す**(`bd ready --exclude-label external-untrusted` を harness 側の
既定コマンドに追加する。1節冒頭 Quick Reference の `--exclude-label gt:slot` と同様の運用)。
人間がチケット本文を読み、必要なら自分の言葉で書き直してこのラベルを外すまでは、
実装エージェントに自動的には渡らない(下の段落の理由)。

### prompt injection で判定を覆されたときに何ができてしまうか(Opus レビュー観点への回答)

両エージェントとも同じ攻撃者制御下の本文を読むため、独立呼び出しであっても
「1体目が `safe` に、2体目が `★5` に、両方とも欺かれる」最悪ケースはあり得る。両エージェント
自身はファイル・コマンド・ネットワークに触れないので、判定を欺いても両エージェントの実行時に
任意コード実行やデータ持ち出しが起きることはない。**ただし「被害の天井は bd チケット1件」
という言い方は不正確だった**: 取り込みボタンを押すと作られる bd チケットは、`bd ready` に
そのまま乗り、実装エージェント(Runner 経由、フルツール)がそのチケット本文を読んで作業を
始めうる。`bd ready` はチケット本文を「信頼できない入力」として扱わない(ARCHITECTURE.md
の Runner 安全保証はチケット**発行**元ではなく実行環境側の最小化であり、チケット本文の
内容そのものは元々「ユーザーが書いたもの」という前提に立っている)。欺かれた★5評価が
そのまま P1 に直結すれば、攻撃者が仕込んだ文面が作業キューの先頭に来てしまう。
これが実際の懸念であり、対策は上の2つ: (1) 自動優先度を P2 で頭打ちにし P1 は人間の
明示操作のみ、(2) `external-untrusted` ラベルで `bd ready`/Runner の自動対象から外し、
人間のレビュー(または書き直し)を挟むまで実装エージェントに渡らないようにする。この2つを
併せた実際の被害の天井は「人間がレビューする前提のキューに、誤解を招く1件が紛れ込む」まで
であり、「実装エージェントが攻撃者の指示どおりに動く」経路には直結しない。

### ARCHITECTURE.md「Runner は単一経路」の書き換え方針

現行の一文「エージェント自動起動(Runner)は単一経路+認可ゲート必須」は、
`POST /api/runs` だけを指す記述として書かれている。今回2つの新しい起動経路
(安全判定・⭐評価)が増えるため、文字どおりの「単一」ではなくなる。書き換え方針:

- 見出しを「エージェント自動起動の経路は認可ゲート必須の集合として管理する」に変える。
- 経路ごとに「認可ゲート」「ツールの天井」を並べた表を追加する:

| 経路 | 認可ゲート | ツールの天井 |
|---|---|---|
| `POST /api/runs`(実装 Runner) | `agent-run-guard` + ローカル直/リモート許可トグル | worktree スコープの Edit・allowlist した Bash 等(既存の3層最小化) |
| 安全判定・⭐評価(不具合報告) | サーバー内部呼び出しのみ。公開 HTTP エンドポイントとして直接叩ける経路は無く、必ず「一覧取得時の初回判定」または「人間が押す再判定ボタン」を経由する(外部の GitHub 編集は、次に人間がこの画面を操作したときの入力内容を変えるだけで、エージェント呼び出しそのものを直接トリガーしない) | 道具ゼロ(`--tools ''` + `--strict-mcp-config` + `--setting-sources ''`。MCP 無し) |

- 「経路が増えることはユーザーが了承済み(2026-09-25)」の注記を添える。

## 9. ハーネス側の変更(項目 i、bdboard-4y8q.12)

- **layering.md「アップストリーム経路」節**: 手順1〜3(`bd create --type=task
  --title="[harness-upstream] ..."` → `bd label add harness-upstream` → bdboard 側が
  ラベルで拾う)を、`scripts/report-issue.sh` の直接呼び出しに置き換える。宛先解決は
  question-template.md の添付画像 API と同じ(既定 `http://localhost:8787`、
  `BDBOARD_PORT` を変えている構成ではそのポート)。bdboard が止まっている場合は
  1秒で諦めて失敗を返し、エージェントはその中身を作業の最終報告に残す(スクリプトが
  失敗を返す設計なので、hook 側で無理にリトライしない)。
  「暫定運用として project-harness にもエントリを置いてよい」の文言はそのまま残す。
- **brushup-protocol.md**: layering.md への参照(「汎用の教訓は harness-upstream チケットで
  運ぶ」)はそのまま残るが、参照先(layering.md)の中身が上記のとおり変わる。
  brushup-protocol.md 自身の「§1 直せないなら起票して現作業へ戻る」(このプロジェクト内
  failure-catalog 用の `bd create --type=task ... harness` )は無関係(公開 issue の話では
  なく、リポジトリ内メモの話)なので変更しない。
- **古い版のハーネスが残る間の共存**: 旧版(bdboard 以外の5プロジェクト)は当面
  `bd create ... harness-upstream` のままになる。bdboard-4y8q.7 がこれを定期的に走査して
  下書きへ取り込む(bdboard-4y8q.1 に依存)。新版に更新したプロジェクトから順に
  `report-issue.sh` の直接送信へ切り替わり、`harness-upstream` チケットは自然に減っていく。
- **pack.json のバージョン**: layering.md 自身の規約(配布スクリプトの挙動が絡む変更は
  patch ではなく minor)により、この変更は **minor** で上げる。
- 規則文書の文面は `model: fable` の最大 effort(選べなければ `opus` で最大熟考)で書く —
  この節の実装(bdboard-4y8q.12)側の受け入れ基準であり、本ドキュメント自体はその対象ではない
  (本ドキュメントの執筆モデルは末尾「メタデータ」節を参照)。

## 10. 未決事項まとめ

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | issue-drafts の既定保存パス | 727y の結論待ち | 727y の基点解決関数をそのまま issue-drafts にも使う(2節) |
| 2 | 道具ゼロ判定(`--tools ''` + `--strict-mcp-config` + `--setting-sources ''`)が実際に道具ゼロを達成しているか | (a) 組み合わせを信じて実装 / (b) 実装時に実測して確定 | (b)。ARCHITECTURE.md の既存注記と同じ理由(8節) |
| 3 | 安全判定・⭐評価に使うモデル | 高精度重視(opus 等) / 低コスト重視(sonnet 等) | 安全判定は誤判定のコストが高いので高精度側、⭐評価は軽量タスクなので低コスト側。具体名は実装時にユーザーと相談 |
| 4 | 新規下書きの1時間20件の数え方 | 暦時間バケツ(実装簡単・境界で緩む) / 真のスライディングウィンドウ(厳密・実装重い) | 暦時間バケツ(4節)。小さな決め事なので実装時に変更してよい |
| 5 | `gh issue create --web` のプレフィル URL 長の実際の閾値(6節手順6) | 実装時に `gh`/ブラウザの実測値で確定 | 実測して確定。超過時の「要約+手動貼り足し」フォールバック(6節)自体は確定事項とする |
| 6 | 外部 issue 取り込み時の per-field 上限(title 300字/body 20000字、8節)の具体値 | この値のまま採用 / 実装時に調整 | このまま採用してよい(セキュリティ境界ではなくコスト制御が目的のため、実装時の微調整を妨げない) |

## 11. 実装チケットの進め方

エピックの `bd children`/`bd dep` にすでに表れている依存関係を、着手順の目安として並べる
(依存が無い列は並行可)。

| 順 | チケット | 内容 | 前提 |
|---|---|---|---|
| 1 | bdboard-727y | 添付画像の保存先バグ修正 | なし(先行させる) |
| 2 | bdboard-4y8q.1 | 下書きの保存・受け取り API、指紋、上限 | 727y、本ドキュメント |
| 2' | bdboard-4y8q.2 | 公開本文の組み立てと置き換え(domain 純粋関数) | 本ドキュメント(1と並行可) |
| 3 | bdboard-4y8q.3 | 「不具合報告」タブの画面 | 4y8q.1、4y8q.2 |
| 4 | bdboard-4y8q.6 | bdboard 本体エラーの下書き化・手書き報告 | 4y8q.1、4y8q.3 |
| 4' | bdboard-4y8q.12 | ハーネス側スクリプト・hook・規則書き換え | 4y8q.1(並行可、4と独立) |
| 5 | bdboard-4y8q.4 | 投稿 API・bd 取り込み | 4y8q.3 |
| 6 | bdboard-4y8q.7 | harness-upstream チケットの定期取り込み | 4y8q.4 |
| 6' | bdboard-4y8q.5 | 投稿済み issue の状態追跡・再発 | 4y8q.4(並行可) |
| 7 | bdboard-4y8q.9 | 届いた issue の一覧・機械検査 | 4y8q.3 |
| 8 | bdboard-4y8q.10 | 安全判定・⭐評価・取り込みボタン | 4y8q.4、4y8q.9 |
| 9 | bdboard-4y8q.8 | Closes #N の自動化(git workflow) | なし(独立。優先度 P3) |

## メタデータ

本ドキュメントは議長の指示により Sonnet が直接執筆した(bdboard-4y8q.11 の受け入れ基準は
`model: fable`/`opus` を指定しているが、担当割り当てが優先する)。
`bd update bdboard-4y8q.11 --set-metadata bdboard.model.design=sonnet-5` を記録する。
