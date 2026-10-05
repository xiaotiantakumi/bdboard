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
  readonly catalogSlug?: string;          // A のみ。受け取った値(ホーム配下の絶対パスは ~/ に畳んだもの)を指紋とは別に持つ(4節「実装との差分」)
  readonly source?: string;               // B/C のみ。同上
  title: string;                          // 公開題名(編集可。初期値は5節の組み立て関数の出力)
  body: string;                           // 公開本文(編集可、同上)
  titleEditedByUser: boolean;             // true なら次の同一指紋マージ時も自動再生成しない(PATCH で題名を空にすると false に戻り自動の値になる。3節)
  bodyEditedByUser: boolean;
  readonly localOnly: LocalOnlyContext;   // 手元だけの生データ(公開本文には使わない。4/5節参照)
  readonly occurredProjects: readonly OccurredProject[]; // 発生したプロジェクトの一覧(手元限定)
  occurrenceCount: number;                // 回数
  readonly firstOccurredAt: string;       // ISO 8601 UTC (末尾 Z)
  lastOccurredAt: string;
  status: DraftStatus;
  dismissReason?: string;                 // 見送りの理由(status='dismissed' のときのみ)
  issueNumber?: number;                   // 投稿後の GitHub issue 番号
  issueUrl?: string;
  sourceTicketRef?: string;               // harness-upstream 取り込み元のチケットID(4y8q.7)。/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/ だけ受け取る
  harnessVersionAtOccurrence?: string;    // A/Bのみ。注入先 .claude/bdboard-packs.json の version(最後の発生のもの。4節 m-6)
  suspectedLeaks?: DraftSuspectedLeak[];  // 直した欄の置き換え漏れの疑い {field,kind,start,end}(PATCH で更新。3節、4y8q.3.1)
  suspectedLeaksOmitted?: number;         // 上限 200 件で落とした数
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

bdboard-727y(添付画像の保存先バグ)は PR #782 で 2026-09-25 にマージ済み。下書きは 727y が
入れた基点解決関数をそのまま使う。727y の結論:

- 基点は `resolveDataDirBase(repoRoot)`(`src/infrastructure/fs/resolve-data-dir-base.ts`)が
  返す。`<repoRoot>/.git` が存在すれば(ディレクトリ = 通常の clone、ファイル = linked worktree の
  どちらでも)git の作業ツリーとみなして `<repoRoot>/data`、存在しなければ npm/npx で
  インストールされた環境とみなして `~/.bdboard`(キャッシュ DB `~/.bdboard/cache.db` と同じ
  決め方)。祖先ディレクトリは辿らない。
- 添付画像はその下の `attachments/<projectKey>/<issueId>/`。`resolveAttachmentsDir(repoRoot, env)`
  が、`BDBOARD_ATTACHMENTS_DIR` が空でなければそれを `path.resolve` して優先し、無ければ
  `resolveDataDirBase(repoRoot)` の下の `attachments` を返す。

下書きはこれに揃える:

- 既定パスは `<基点>/issue-drafts/<id>/`。git の作業ツリーでは `<repoRoot>/data/issue-drafts/<id>/`、
  npm/npx 環境では `~/.bdboard/issue-drafts/<id>/`(どちらも添付画像の `attachments` の隣)。
- 環境変数での上書きは `BDBOARD_ISSUE_DRAFTS_DIR`(`BDBOARD_ATTACHMENTS_DIR` と対称の名前)。
  `resolveAttachmentsDir` と同じ形の純粋関数 `resolveIssueDraftsDir(repoRoot, env)` にし、
  基点は `resolveDataDirBase` を呼ぶ(自前で `.git` を見ない)。空文字を未設定とみなす点、
  上書き値を `path.resolve` する点も同じにする。
- キャッシュ DB(`~/.bdboard/cache.db`)の中には置かない(エピック決定どおり)。npm/npx 環境では
  DB と同じ `~/.bdboard` の下になるが、DB とは別のディレクトリ・ファイルである。
- `.gitignore` が除外しているのは今 `/data/attachments/` だけで、`/data/` 全体ではない。
  bdboard-4y8q.1 で `/data/issue-drafts/` の行を足す。README の環境変数の表にも
  `BDBOARD_ISSUE_DRAFTS_DIR` の行を足す(`BDBOARD_ATTACHMENTS_DIR` の行と同じ書き方)。
- パーミッション: 添付画像の保存(`fs-attachment-storage.ts`)は `mkdir`/`writeFile` に mode を
  渡しておらず、umask 任せ(通常は `0755`/`0644`)である。下書きには4節で述べる `errorTextRaw`
  (手元限定・非公開の生ログ)や元チケットの本文が入るので、添付画像には揃えず、ディレクトリは
  `0700`、ファイルは `0600` を明示して作る(所有者のみ読み書き可)。

## 3. 受け口の API とローカル直アクセス限定(項目 c)

3つの経路があり、要求される認可の強さが異なる。

| 経路 | メソッド/パス | 呼び出し元 | 必要な認可 |
|---|---|---|---|
| 受け取り | `POST /api/issue-reports/drafts` | 各プロジェクトに注入される報告スクリプト(注入先では `.claude/skills/bdboard-harness/scripts/report-issue.sh`、パック正本は `harness/packs/bdboard-harness/scripts/report-issue.sh`。4y8q.12)、bdboard 自身のエラー捕捉(4y8q.6) | **ローカル直アクセスのみ**(トンネル不可) |
| 閲覧・編集・見送り | `GET /api/issue-reports/drafts`、`GET .../:id`、`PATCH .../:id`、`PATCH .../:id/dismiss`、`GET /api/issue-reports/pending-count` | 不具合報告タブの UI | PATCH は通常の write-guard(ローカル直 または 強パスワード+セッション Cookie のトンネル)。GET は `createWriteGuardMiddleware` の対象外(メソッドで素通しする)なので、ほかの読み取り API と同じく、トンネルではトンネルの認証(Basic 認証)を通れば読める(パスワードの強度は問わない)。**ただし `GET .../:id` だけは、全部を返すのはローカル直アクセスのみ**(下の「1 件の取得はトンネルでは絞る」) |
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
する(CSRF チェックは維持したまま。`write-guard.ts` 132〜136行)。さらに
`createWriteGuardMiddleware` と違い**全 HTTP メソッドに適用される**ので、受け取り(POST)・
投稿(POST)はもちろん、GET 系のエンドポイントを同じ強さで塞ぎたくなった場合にも使い回せる。
つまり:

```ts
const localOnlyGuard = createPrivilegedApiGuardMiddleware({}); // トンネル deps を渡さない
```

の1行を受け取り・投稿の2ルートへ前置するだけでよい。新しいミドルウェア関数を書き起こさない。

既存のローカル直アクセス限定のルートは、どれもこの形ではなく `isLocalBasicAuthRequest` を
直接呼ぶ手書きの判定である。`createPrivilegedApiGuardMiddleware` を `deps` 無しで使うのは
本設計が初めてになる:

- `PUT /api/settings/agent-runs`(bdboard-54be.1): `createWriteGuardMiddleware(deps.writeAccess)`
  (トンネル deps あり)の内側で、ハンドラの先頭に `isLocalBasicAuthRequest` の判定を置く
  (`agent-run-settings-routes.ts`)。
- `/api/tunnel` と `/api/tunnel/*`(GET と POST。DELETE は無い): `tunnel-routes.ts` の手書きの
  `localOnlyGuard`。このガード自身は CSRF を見ない。POST が CSRF の検査を通るのは、先に
  mount される `inner`(`routes.ts`)の `app.use('*', createWriteGuardMiddleware(...))` が、
  後から `app.route('/', …)` で載せた兄弟のサブアプリのルートにも掛かるため(Hono の挙動。
  `mount-routes.ts` の mount 順に依存する)。上の1行はガード自身が CSRF も見るので、mount 順に
  依存しない。
- `/api/chat/projects/:projectId/discovered-sessions` とその下: `chat-routes.ts` 176〜183行の
  `discoverySessionsLocalOnlyGuard`。CSRF は前段の `chatGuard` が見る。
- なお `chat-agent-routes.ts:79` の `isLocalBasicAuthRequest` はレート制限を飛ばす判定で、
  ローカル限定のゲートではない。

### 1 件の取得はトンネルでは絞る(bdboard-4y8q.1 のレビュー M-1)

`GET /api/issue-reports/drafts/:id` は、下書きの `localOnly`(1節)をそのまま返すと、
`errorTextRaw`(64Ki 文字までの生ログ。トークンを含みうる)と `occurredProjects[].path`(絶対パス)を、
トンネルの Basic 認証を通っただけの読み手へ渡してしまう。生ログと cwd をローカル限定にした
`GET /api/runs/:runId`(bdboard-54be.1 M-1、`agent-run-read-routes.ts`)と同じ理由で、
`isLocalBasicAuthRequest(c)` で分ける:

| 呼び出し | 応答 |
|---|---|
| ローカル直アクセス | 下書き全部 + `restricted: false` |
| それ以外(トンネル、ループバックでない接続元、Host の不一致、接続情報なし=fail-closed) | `restricted: true`。**許可リスト**(`toDetailDto`)で組んだ次の欄だけ(下) |

トンネル側が**見る欄の全部**: `id`、`kind`、`fingerprint`、`catalogSlug`、`source`、`title`、`body`、
`titleEditedByUser`、`bodyEditedByUser`、`localOnly.errorTextTruncated`、`localOnly.envInfo`(版)、
`occurredProjects[]` の `name` / `firstSeenAt` / `lastSeenAt`(パス無し)、`occurrenceCount`、
`firstOccurredAt`、`lastOccurredAt`、`status`、`dismissReason`、`issueNumber`、`issueUrl`、
`sourceTicketRef`、`harnessVersionAtOccurrence`、`suspectedLeaks`・`suspectedLeaksOmitted`(下の「閲覧・編集(PATCH)側のフィールド範囲」。
トンネル側は、返す(畳んだ)題名・本文にかけ直した値)、`draftSchemaVersion`、`restricted`。画像の一覧は別の API。
応答の外側には `latestHarnessVersion`(この bdboard の `harness/packs/bdboard-harness/pack.json` の `version`。読めなければ `null`。
全 pack を読む `listPacks` の結果を 30 秒使い回す: 版が変わるのは bdboard の更新のときで、再起動でも作り直され、ずれるのは版の比較の表示だけ。失敗はキャッシュしない。pack が一覧に無い結果(`undefined`)は失敗ではないので 30 秒キャッシュする。読み込み中の共有にも同じ 30 秒の期限を掛け、終わらない読み込みを期限なく共有しない(期限を過ぎたら新しく読む。bdboard-ov0t)。値の期限は読み終えた時刻から数える。置き換えられた古い読み込みが先に終わったときも、より新しく始めた読み込みの値がまだ無ければその値を使う(読み込みが毎回 30 秒より長くても値が覚えられる。bdboard-pvff)。bdboard-pnvj)も載せる
(秘密ではないので、ローカル直アクセスかどうかで分けない)。
このうち**呼び出し側・利用者の入力がほぼそのまま入る**のは次で、手元の外へ出てよい形に入口で絞る:

| 欄 | 入口での絞り |
|---|---|
| `source` / `catalogSlug` / `envInfo` の版の文字列(`fingerprint`・`title`・`body` にも入る) | **識別子**。1 行のみ: 改行・制御文字・不可視の書式文字(下の「1 行の検査」)を含むと 400。ホーム配下の絶対パスは**受け取りで `~/` に畳む**(400 にはしない。畳む形は下の「ホーム配下のパス」)。`GET /api/x` のような API のパスは触らない。パス以外の秘密(引数のトークンなど)は見つけない |
| `project.name`(`occurredProjects[].name`) | **表示用**。400 にせず整える。順番が大事: ① 改行・タブ・そのほかの制御文字・行区切り(U+2028/2029)・BOM と、画面では空白に見える文字(ハングルの埋め字 U+115F・U+1160・U+3164・U+FFA0 と U+180E)は**空白に置き換える**(パスの手前の区切りにもなる文字なので、取り除くと前の語に繋がり、`proj<TAB>/Users/u/proj` や `proj<U+3164>/Users/u/proj` のパスが畳めなくなる)、② 1 行の検査で弾くそれ以外の文字(ゼロ幅 U+200B・WORD JOINER U+2060・ソフトハイフン U+00AD・ZWJ・双方向制御など、画面で何も見えない文字)は取り除く(空白にしない: 取り除いた結果が画面に見える文字列と一致し、`/Us<ZWSP>ers/u` の形崩しも畳める。手前の語にパスが貼り付いて見える `proj<ZWSP>/Users/u/proj` は、`proj/Users/u/proj` と打ったのと同じなので畳まない)、③ ホーム配下のパスを `~/` に畳む(②の後なので `/Us<ZWSP>ers/u` も畳まれる)、④ 空白の連なりを 1 つにして前後を落とす。`👩‍💻-tools` は受け取るが、ZWJ は取り除かれ `👩💻-tools` として保存される。整えた結果が空なら 400。手元限定の `project.path` は触らない |
| `sourceTicketRef` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$` だけ(`--db=/tmp/evil` は 400)。後で `bd` の引数になる(6節) |
| `dismissReason` | 表示用の 1 行・200 文字まで(PATCH の入口)。貼り付けで混ざるゼロ幅スペース U+200B と BOM U+FEFF は取り除き、ZWJ U+200D・ZWNJ U+200C は許し、改行・制御文字・そのほかの不可視の書式文字は 400。取り除いたあとに見える文字が残らない(空白・ZWJ・ZWNJ・結合文字 `\p{M}`(異体字選択子 U+FE0F・結合用の書記素連結子 U+034F・U+17B4・IVS の U+E0100 を含む)・点字の空白 U+2800 だけ)ものも 400。`e` + U+0301 のように、結合文字の手前に見える文字があれば通る。パスは畳まない。本文を書く欄ではない |

**1 行の検査**(`isSingleLineText`): 次の文字を 1 つでも含むと不可。制御文字(Cc: 改行・タブ・DEL・C1)、書式文字(Cf: ゼロ幅
U+200B–200F、双方向制御 U+202A–202E と U+2066–2069、ALM U+061C、単語結合子と不可視の演算子 U+2060–2064、
U+206A–206F、BOM U+FEFF、ソフトハイフン U+00AD、U+180E、注釈記号 U+FFF9–FFFB、タグ文字)、行・段落の区切り
(Zl・Zp: U+2028・U+2029)、ハングルの見えない埋め字(U+115F・U+1160・U+3164・U+FFA0)、タグ文字の区画全体
(U+E0000–E007F。割り当て前の番号を含む)。異体字選択子(日本語の IVS を含む)・結合文字(濁点の分解形)・全角スペース
U+3000 は許す。孤立したサロゲートは見ない(4y8q.2)。これで防ぐのは行の数と見えない文字だけで、1 行でもリンク・`@`メンション・
`#`参照・`<img>` は書ける(Markdown のエスケープと公開本文の置き換えは5節、4y8q.2)。

**ホーム配下のパス**(`foldHomePaths`、`src/domain/issue-draft-identifier.ts`): 次の形だけを `~/` に畳む。ユーザー名の
部分(と、その後ろの区切りまで)が `~/` になり、それより奥はそのまま残る。
- `/Users/<名前>`(macOS)、`/home/<名前>`(Linux)、`/var/home/<名前>`、`/usr/home/<名前>`。`Users` は大文字小文字を区別しない
  (`/users/<名前>`)
- `/mnt/<ドライブ文字>/Users/<名前>`(WSL)、`/<ドライブ文字>/Users/<名前>`(Git Bash)、`/cygdrive/<ドライブ文字>/Users/<名前>`
- `/System/Volumes/Data/Users/<名前>`、`/Volumes/<ディスク名>/Users/<名前>`(macOS)
- `X:\Users\<名前>`、`X:/Users/<名前>`(JSON の中の `X:\\Users\\` も)、`\\?\X:\Users\<名前>`、`file:///X:/Users/<名前>`
- `\\wsl$\<distro>\home\<名前>`、`\\wsl.localhost\<distro>\home\<名前>`

パスとして読むのは、**直前が行頭・空白・`'` `"` `` ` `` `=` `:` `(` `,` `;` `|` `<` `>` `[` `{`・`file://`・`\\?\` のどれかのときだけ**
(境界の規則)。だから `GET /api/home/x` や `POST /api/Users/42` のように途中に現れるものは触らない。逆に、行頭や空白の
直後の `GET /Users/42` や `GET /home/settings` は区別できないので `GET ~/` になる。名前は区切り(`/` `\`)・空白・
引用符・リストの区切りと括りの開閉(`` ` `` `:` `;` `,` `|` `<` `>` `(` `)` `[` `]` `{` `}` `=`。`(` は、後ろが次のパスの頭でなければ名前に入れる:
下を参照)・改行・文字列の終わりで終わる。だから
`/home/u:/home/u/bin` は `~/:~/bin`、`x=/Users/u;y=/Users/u/z` は `x=~/;y=~/z`、`C:\Users\u;C:\Users\u\bin` は `~/;~/bin`
になり、区切りの先の次のパスも別々に畳まれる(名前の欄にこれらの文字は入らないので、巻き込まない)。ただし Windows の名前だけは
半角スペースを含みうる(`John Smith`)ので、上の止まる文字・改行・文字列の終わりまでを名前として読む(改行は名前に入れない:
複数行の本文で、次の行以降を巻き込んで消さない): **`bash C:\Users\u --flag` は `bash ~/` になる**(引数を残すより、
ユーザー名を残さないことを優先する)。ただし**空白か `(` の直後が `X:\`・`X:/`(ドライブ文字)か `/`・`\`(間に `(` があってもよい)
のときは、次のパスの頭なので、その手前で名前を終える**: `cd C:\Users\u && node C:\Users\u\x.js` は `cd ~/ ~/x.js`、
`C:\Users\u D:\Users\u\x` は `~/ ~/x`、`cp C:\Users\u /home/u/x` は `cp ~/ ~/x`、`cwd C:\Users\a (C:\Users\a\x.js:1:2)` は
`cwd ~/ (~/x.js:1:2)`、`C:\Users\u(D:\Users\v\x)` は `~/(~/x)` になり、次のパスも別に畳まれる
(以前は次のパスの頭を名前に飲み込み、`cd ~/:\Users\u\x.js` のように次のユーザー名が残った。bdboard-4lea)。POSIX・WSL の名前も
`(` だけ同じ規則で、`/home/u(/home/v/y` は `~/(~/y` になる(`/Users/(name` のように次のパスの頭でない `(` は名前に入るので畳む)。
共有の場所(`/Users/Shared`・`C:\Users\Public`・`/home/linuxbrew`)も同じ形なので畳まれる。見つけないもの: `x@/Users/u`
のように `@` などの直前(境界でない文字)に続くもの、`~name/`、`\\server\share\Users\u` のような UNC、リポジトリの内側の相対パス、
パス以外の秘密。

**既知の取りこぼし(bdboard-4lea)**: `` ` `` `)` `{` `}` `'` は Windows のアカウント名に使える文字だが、上の止まる文字でもあるので、
名前の途中にあると、そこから先の名前が残る(畳むのは手前まで): `C:\Users\O'Brien\x` は `~/'Brien\x`、`C:\Users\a)b\x` は `~/)b\x`。
名前が `{` で始まる `C:\Users\{bob}\x` は畳めない(R4-3 より前は `~/x` になった)。これらを Windows の名前の中だけ許す案は、
パスの直後に付く閉じ括弧・閉じ引用符・閉じバッククォート(`(C:\Users\u)`、`` `C:\Users\u` and more ``)まで名前に巻き込んで、
区切りの先を消す。`C:\Users\u)rest` が `~/)rest` になる R4-3 の名前の終わりの記号と両立しないので、見送った。
括弧の対(`{bob}`)だけ許す案も、`` ` `` と、対にならない `)` `}` は救えず、規則が増えるわりに効果が小さいので採らない。
`[` `]` は Windows のアカウント名に使えない文字なので、取りこぼしではない。

**多層防御**: 名前や文を載せる欄(`fingerprint`・`catalogSlug`・`source`・`title`・`body`・`occurredProjects[].name`・
`localOnly.envInfo` の版の文字列・`harnessVersionAtOccurrence`)は、応答を組むときに `foldHomePaths` をもう一度かける。受け取りで
畳んであるはずの値だが、畳み方の漏れや、保存先へ直接書かれた値(受け取りを通らなかった古い下書きなど)があっても、ホーム配下のパスの
ユーザー名を手元の外へ出さないため。`fingerprint` は、頭の種別の印(`A:` `B:` `C:` `mass-occurrence:`)があればそれを残して後ろを畳み、そのあと全体をもう一度畳む(`B:/Users/u/x` の `B:` を Windows のドライブ文字と読んで印ごと消さないため。`C:\Users\u\x:abcd` のように印の形で始まるドライブ文字のパスや、印の無い `/Users/u/x:abcd` は、最初の `:` で切らず全体を畳む)。同じ畳み込みを一覧の `fingerprint` と
`title` にもかける。畳むのは上の形だけで、`dismissReason` や、ほかの秘密の除去ではない。

**指紋の取りこぼし(bdboard-4lea)**: 指紋の畳み方には、字面だけでは区別できない 2 つの形がある。どちらも、受け取りを通らず
畳んでいない出どころが保存先へ直接書かれた指紋だけで起きる(受け取りは出どころを先に畳むので、`B:~/hook.ps1:abcd` の形で保存される)。
- 印の文字と同じドライブ文字のルート直下のパス(`B:\Users\u\hook.ps1:abcd`)は、全体をドライブ付きのパスと読むので
  `~/hook.ps1:abcd` になり、印(`B:`)が消える。ユーザー名は残らない。
- 印の文字と同じドライブ文字の、空白を含む名前(`C:/Users/John Smith/x:abcd`)は、印を残して後ろを POSIX の名前(空白で止まる)
  として畳むので `C:~/ Smith/x:abcd` になり、空白より後ろの名前の一部が残る。

印か Windows のドライブ文字かを字面から決める手立てが無く、どちらの解釈を選んでも別の形が壊れる(`B:/Users/u/x` の印を残すことが
R4-4 の目的)ので、コードでは扱わず、ここに書いた割り切りにした。

どの読み手に畳むか: **`toSummaryDto`(一覧・受け取り・見送りの応答)は、ローカル直アクセスにも畳んで返す**。受け取りを通した値は
すでに畳んであって、畳み込みは何度かけても同じ結果(冪等)なので、受け取りで書いた値は同じ値で返る。違いが出るのは、
受け取りを通らず保存先へ直接書かれた生の下書きだけ。1 件の取得 `GET drafts/:id` のローカル直アクセスの応答(`toDetailDto` の `local`)
は畳まず、保存された値のまま返す。

トンネル側で落とす欄: `errorTextRaw`、**`errorTextHead` / `errorTextTail`**、`symptomRaw` / `causeRaw` /
`preventionRaw` / `agentNoteRaw`、`foldedFingerprints`、`occurredProjects[].path`。
`errorTextHead` / `errorTextTail` を落とすのは、短いエラー文では先頭がそのまま生ログになり(2000 文字
以下なら `errorTextHead` が全文)、残すと上の制限が意味を失うため。**判断**: 当初案は「head/tail は残す」
だったが、4y8q.1 の時点では head/tail は置き換え(5節、4y8q.2)を通る前の生の切り出しである。4y8q.2 が入って
head/tail が置き換え後の文章から作られるようになったら、トンネル側へ戻すかどうかを再判断する。
応答は許可リストで組む(`toDetailDto`)ので、下書きに欄が増えても、足すまでは手元の外へ出ない。
一覧(`GET .../drafts`)の応答には、もともと本文も `localOnly` も載せない。載せるのは `id`・`kind`・
`fingerprint`・`title`・`status`・回数・時刻・プロジェクト数・`dismissReason`・`issueNumber`・`issueUrl`・
`sourceTicketRef` で、`fingerprint` と `title` に入る `source` / `catalogSlug` は上の表の絞りを通った値(さらに上の多層防御の畳み込みをかけて返す)。
一覧の応答の外側には、読んだ一覧から数えた `pendingCount`(未処理の件数)も載せる(bdboard-4y8q.3.1)。数え方は `pending-count` と
同じ `countPendingStatuses` で、`listWithPendingCount()` が読んだ一覧そのものに掛ける(bdboard-vsuc)。

画像(`GET .../images/:fileName`): **トンネル経由では見せない**(bdboard-4y8q.3.2 で決定)。スクリーンショットには生ログと
同じ種類の秘密が写りうるので、生ログと同じ扱いにする。API は受け取り・画像の追加と同じローカル直アクセス限定のガード
(`localOnlyGuard`)を掛け、トンネル経由は書き込み許可つきのセッションがあっても 403。画面(不具合報告タブの「投稿されない
手元の情報」)も、トンネル経由(`restricted: true`)では画像の名前と大きさを文字で出すだけでリンクにせず、注意書きに
「添付画像は開けません」と書く。ローカル直アクセスでは名前を押すと別のタブで開く(プレビューでは読み込まない)。
添付画像の URL の直開き(アドレスバーに貼る・ブックマーク)は、ローカルでも 403(ガードの Fetch Metadata の検査で
`Sec-Fetch-Site` が `same-origin` でないため。応答の文言はガード共通の `cross-site write blocked` のまま)。画面のリンクから開く。

### 閲覧・編集(PATCH)側のフィールド範囲

3節冒頭の表で「閲覧・編集・見送り」はトンネル経由(強パスワード+セッション Cookie)でも
許可しているが、これは「編集画面を使わせる」ためであって「任意のフィールドを書き換えて
よい」という意味ではない。`PATCH /api/issue-reports/drafts/:id` が受け付けるフィールドは
次に限定し、それ以外のキーを含むリクエストは 400 で拒否する:

- `title`、`body`(公開前の編集用。どちらか一方だけでもよい)。`titleEditedByUser` / `bodyEditedByUser` は**送らせない**
  (送ると 400)。サーバーが、渡された欄の分だけ true にする(bdboard-4y8q.3.1 で、当初の「4 つを受け付ける」から改めた。
  利用者が印だけを倒して、直した文を次の受け取りの自動の作り直しで上書きさせる道を作らない)。
  **見える文字が無ければ自動生成へ戻る**(bdboard-pnvj、bdboard-ov0t): 見える文字が 1 つも残らない `title` / `body`(`""`・空白だけ・
  ZWSP `U+200B` や点字の空白 `U+2800` や BOM やそのほかの幅の無い・描かれない文字だけ。判定は 1 つの `hasVisibleText` で、題名も本文も同じ。
  「見える文字」の意味は、3節の表の `dismissReason` の行と、4節「実装との差分」の「見送りの理由の見える文字」と同じ。見送りの理由は先に
  1 行の検査が制御文字・不可視の書式文字を 400 にするので、判定の広さの違いは結果に出ない)を渡すと、その欄の「直した」印を false に戻し、題名・本文を今の下書きの状態(回数・時刻・版)から
  自動で組み直した値にする(`autoTextOf`。受け取りが直していない欄を作り直すのと同じ文)。渡していない欄は値も印も変えない。
  以前は `body: ""` が空の本文を「直した」印つきで保存し(bdboard-pnvj で修正)、そのあとも本文は `trim()` で空になるものだけを戻したので、
  ZWSP や `U+2800` だけの本文は「直した」見えない本文として保存された。題名も、`"\u2800"` だけだと空ではなく 400 だった(ZWSP だけなら戻っていた)。
  見える文字が 1 つでもあれば、その文字列はそのまま「直した」文として保存する(本文の見えない文字は消さない)。両方の欄の印が false に戻ったら、
  保存してある置き換え漏れの疑い(`suspectedLeaks` / `suspectedLeaksOmitted`)も下書きから取り除く(一度も直していない下書きには無い、
  という約束と揃える)。片方の印が残るときは、残った欄だけをかけ直す。
  画面(不具合報告タブの「直す」)は、変えた欄だけを送るので、欄を空にして保存すればこの道を通る(入力欄の下に注意書きを出す)。
  ただし bdboard-pnvj より前に `""` と「直した」印で保存された欄は、編集欄が初めから空で、保存しても変えた欄が無く何も送らない。
  そこで「直した」印の付いた欄(`titleEditedByUser` / `bodyEditedByUser` が true)の下に **「題名を自動の文に戻す」「本文を自動の文に戻す」**
  ボタンを出す(bdboard-494n)。押すと入力の差分を見ずに、その欄だけを `""` にした PATCH を送る(API の追加は無い。上の道をそのまま使う)。
  直した文か未保存の入力が残っているときは、押したあとに「捨てて戻す」「戻すのをやめる」の確認を挟む。成功すると編集欄は開いたまま、
  その欄を自動の文にそろえ(もう片方の欄の未保存の入力は残す)、失敗は保存と同じ言葉で出す。起動時に保存済みの下書きを書き換える移行はしない
  (利用者のデータの意味を黙って変えない)。
  **`title` と `body` の長さは入口(4y8q.3.1)で上限を掛ける**: `draft.json` は 200KB まで(4節「上限」)で、縮めるのは
  生ログ・一覧・メモなどだけ。題名・本文は縮める対象にしていないので、保存層は 200KB を超える下書きを
  黙って書かずに断る(`save` が投げる)。入口で止めないと、編集の保存が 500 になる。実装(`issue-report-edit-routes.ts`):
  - 題名は 1 行(見送りの理由と同じ整え方: ZWSP・BOM を落とし、ZWJ・ZWNJ は許し、見える文字があるのに含まれる改行・制御文字・
    不可視の書式文字は 400。見える文字の無いものは 400 にせず上の「戻す」指定。前後の空白を落とす)で **256 文字**まで、本文は **65536 文字**まで(どちらも GitHub の
    issue の上限。UTF-16 のコード単位で数える)。超えたら **413** `{"error":"title or body is too long","code":"too-long",…}`。
    本文の文字の種類は見ない(見えない文字の可視化は投稿前の確認画面の仕事。5節「プレビュー表示時の注意」)。
  - リクエスト本文そのものは 512KiB まで(超えたら読む前に 413)。65536 文字の本文が JSON のエスケープで膨らんでも入る大きさ。
  - 文字数の上限を守っても、制御文字の JSON エスケープ(1 文字 6 バイト)で `draft.json` が 200KB を超えうる。**編集の上限は
    200KB から余白 32KiB を引いた 168KiB**(`ISSUE_DRAFT_EDIT_HEADROOM_BYTES`)。編集で上限を超えた分は**生ログ(`errorTextRaw`)の
    末尾だけ**を削り(切れ目は行の境目へ戻し、サロゲートの対を割らない: 5節「欄の端の断片」。`errorTextTruncated` を true にし、
    応答の `errorTextTrimmed` を true にする)、生ログを削り切っても超えるときは
    保存せずに **413** `{"error":"draft would exceed the size limit","code":"draft-too-large"}`(500 にしない)。見送り・回数の追加と違い
    `fitDraftToByteLimit` は使わない — それは発生したプロジェクトの一覧や畳んだ指紋も縮めるので、利用者の編集が発生の記録を消して
    しまう(bdboard-4y8q.3.1 のレビュー M-2)。置き換え漏れの検出(下)は削った後の下書きにかける。
  - **余白の理由**(再レビュー m-B): 編集で 200KB ちょうどまで膨らませると、次の受け取りや見送りが `fitDraftToByteLimit` で古い
    プロジェクトや人が書いた欄(症状など)を削る。トンネルの書き手が「次の自然な受け取り・見送りで消える」状態を作れてしまう。
    余白は受け取り 1 回分と見送り 1 回分の増分の上限から決めた: 新しいプロジェクト 1 件(path 1000 文字 × エスケープで最大 6 バイト +
    name 200 文字 × 3 バイト ≈ 6.8KB)、版の入れ替えと自動の本文に載る版(≈ 4KB)、直した欄の疑いのかけ直し(最大 200 件 × 約 66 バイト
    ≈ 13.2KB)、見送りの理由(200 文字 × 3 バイト ≈ 0.7KB)で約 25KB、切りのよい 32KiB にした。受け取りを何度も重ねて 200KB に
    届けば、古いプロジェクトから落とすのは従来どおり(4節「上限」)。受け取りで既に 168KiB を超えている下書きは、編集で今より
    大きくしなければ通す(余白を割ったのは編集ではない)。割り切り: 生ログの無いそのような下書きでは、直した欄に付く疑いの欄
    (空でも数十バイト)の分だけ大きくなる編集も 413 になる。
  - **既知の限界**(再レビュー n-C): `errorTextTrimmed` と 413 の境目から、手元だけの欄(生ログ・プロジェクトのパスなど)の合計の
    **大きさ**を、トンネルの書き手が本文の長さを変えた二分探索で知りうる。中身は分からない。
  - `pending` 以外は **409** `{"error":"draft is not pending","status":…}`(見送りと同じ形)。合計容量の上限に当たれば 507。
  - 直した欄(`titleEditedByUser` / `bodyEditedByUser` が true の欄)に、5節の置き換え漏れの検出(`detectSuspectedLeaks`)を
    かけ直し、`suspectedLeaks`(`field`・`kind`・`start`・`end`。位置の順に最大 200 件)と `suspectedLeaksOmitted`
    (上限で落とした件数)を下書きに保存して応答にも載せる。一致した文字列は保存しない(位置で切り出せる。`draft.json` を
    大きくしない)。置き換えはしない(利用者の文を黙って書き換えない)。手元の鍵は発生したプロジェクトのパスと名前だけ
    (ユーザー名・ホスト名・ブランチ名は受け取りに無い。5節「4y8q.2 の範囲外」)。印(`RedactionMark`)は無いので、
    `<project>` のような印の文字列の中の一致も疑いに出る(過検出の側)。自動で組んだ(直していない)欄は調べない。
    これは `buildPublicIssueBody` の配線ではない(検出だけ。5節の「どこにも配線してはいけない」は組み立ての側)。
    直した欄がある `pending` の下書きに、まとめで新しいプロジェクトが加わったときも、広がった鍵でかけ直して保存する
    (`addOccurrence`。直した文は作り直さないので、かけ直さないと新しいプロジェクトの名前が疑いに出ない。レビュー m-1)。
  - 応答は `{ draft, errorTextTrimmed }`。`draft` は `GET .../:id` の `draft` と同じ形(ローカル直は全部、トンネルは
    `restricted: true` の許可リスト)だが、`images` と `latestHarnessVersion` は載せない(画像も版も編集では変わらない。要るなら
    GET し直す)。トンネル側の `suspectedLeaks` は、保存した位置(畳む前の文字列の位置)ではなく、返す畳んだ題名・本文に
    **トンネルにもう見えている鍵だけ**(発生したプロジェクトの表示名を、トンネルに返すのと同じく `foldHomePaths` で畳んだもの。プロジェクトのパスは使わない)でかけ直した位置にする
    (`displayedKeysOf`)。疑いの種類と位置は鍵との一致を伝えるので、パスを鍵に使うと、題名・本文に書いたパスの当て推量が
    合っているかをトンネルの読み手が確かめられてしまう(レビュー M-1)。そのためトンネルの疑いはローカル直より少ないことがあり、
    パスの疑いは出ない。`GET .../:id` のトンネル応答も同じ。
  - **トンネル側の検出の結果は再利用する**(bdboard-pnvj): トンネル経由の `GET .../:id` と `PATCH` の応答は、返す題名・本文にその場で検出をかけ直す
    ので、本文 × 鍵の数に比例して毎回かかる(実測: 検出は 3〜8ms、指紋の計算は 0.14ms。#882 のレビュー時の 565ms は、鍵ごとに正規表現を作っていた #886 より前の値)。`issue-report-leak-cache.ts` が、**下書き id ごと**に
    入力の指紋(**検出がかかる欄**の題名・本文と鍵の値の sha256。直した欄だけが検出の対象なので、直していない欄の自動の文は入れない: 受け取りのたびに
    回数・時刻で変わるので、入れると題名だけ直した下書きが受け取りのたびに外れる。bdboard-ov0t。検出する欄は `scannedFieldsOf` が検出と指紋で共有する)が同じあいだ
    結果を持ち回る。検出する欄か鍵(発生したプロジェクトの表示名)が変われば指紋が変わるので、
    再利用は編集と新しいプロジェクトの追加の後に古い結果を返さない。上限は 256 件(いちばん長く使われていないものから落とす)。ローカル直アクセスは保存した
    疑いをそのまま返すので、検出もキャッシュも通らない。
- **未処理件数**: `GET /api/issue-reports/pending-count` → `{ "pendingCount": N }`(タブのバッジとデイリーダイジェスト用。読み取りなので
  トンネルの Basic 認証で読める)。受け取りの索引(`issue-draft-index.ts`)に状態を持たせて数え、呼ぶたびに全件の `draft.json` を
  読まない(全件を読むのは 1 回だけ: 起動時の掃除の棚卸しが読んだ中身から作る。掃除が失敗した・一覧が欠けていたときだけ、
  起動後の最初の受け取りか件数の問い合わせが読む。bdboard-xvo2)。**数え方は 1 つ**(bdboard-vsuc): 未処理の数え方は
  `countPendingStatuses` だけで、一覧の `pendingCount` は `listWithPendingCount()` が読んだ一覧そのものから、`pending-count` は索引
  (`statusById`)から、同じ関数で数える。索引はサーバーの外の変更を追わないが、一覧を読むたびに、完全な一覧で、かつ読んでいる
  あいだに索引への書き込みが無かったときだけ、`statusById` を一覧に突き合わせる(`syncStatuses`。手で消した下書きを落とし、手で
  足した下書きを入れる。欠けた一覧(`complete: false`)は読めなかっただけで下書きが残っているので、消さない。書き込みが重なったら
  突き合わせを見送る: 古い一覧で、書いたばかりの状態を戻さないため)。割り切り: 手で消した `pending` の下書きは、次に一覧を読む
  まで、または同じ指紋が届くか再起動するまで `pending-count` に残る(一覧を読んだあとに問い合わせた `pending-count` は一覧と合う。
  web は一覧と件数を並行に取るので、手で消した直後は件数が先に返ると、次のポーリング(60 秒)まで最長でずれうる)。期限と容量の
  掃除が消した下書きは、掃除が `onRemoved` で索引(`statusById` と `idByFingerprint`)から落とすので、索引は増え続けない。一覧が
  欠けているあいだの `pending-count` は、直近の欠けた索引を 30 秒使い回して(`getForCount`)全件を読み直さない(受け取りは、
  二重に作らないために、欠けた一覧のあいだは今までどおり毎回読み直す)。見送りは、その使い回す欠けた索引にも書く
  (`noteStatus`)ので、欠けた一覧のあいだも件数にすぐ効く。
- `dismissReason`(`/dismiss` 経由。`status` を直接 `'dismissed'` に書き換えさせず、
  専用エンドポイント `PATCH .../:id/dismiss` に限定する)

`status`(`'posted'` への遷移)、`issueNumber`/`issueUrl`、`fingerprint`、`occurrenceCount`
等の集計・確定フィールドは PATCH の対象外とし、サーバー側(6節の投稿フロー、4節の受信処理)
だけが書き換える。トンネル経由の書き込みは強パスワードを要求するとはいえ、フィールドを
無制限にすると「見る・直す・見送るまで」というエピック決定4の意図を超えて `status='posted'`
相当の状態を外形的に作れてしまう余地が残るため、ここは型(許可フィールドの union)とサーバー
側バリデーションの両方で塞ぐ。

### 条件付き GET と編集の If-Match(bdboard-mqoa)

下書きの一覧・1 件の取得に ETag を付け、編集(`PATCH .../:id`)に If-Match を受けさせる。目的は 2 つ: 変わっていないものを毎回
読み直さない(304)ことと、**別の場所(別のタブ・別の端末)で直した内容を、読んでいない側の保存が黙って上書きしない**こと
(これまでは最後の書き込みが勝った)。HTTP のヘッダは interface 層に閉じる(`issue-report-etag.ts`)。応用層の
`IssueDraftService.edit` は、ヘッダを知らない `precondition(現在の下書き) => Promise<boolean>` を受けるだけ。

- **ETag の作り方**: 応答の本文そのものの版(強い ETag `"<sha256 の先頭 32 桁>"`)。下書きの中身だけでなく、本文に出る画像の一覧・
  最新の harness pack の版・ローカル/トンネルで絞った形・DTO の形と検出の規則を全部含む(組み立てたあとの DTO から作るので、
  どれかが変わったのに ETag が変わらない、が起きない)。作る前にキーを並べ替える(`canonicalJson`): 保存層は読むとき zod でキーの順を
  直すので、編集した直後のメモリ上の下書きと次に読み直した下書きで `JSON.stringify` が違いうる。並べ替えないと、PATCH の応答の ETag で
  次の PATCH を送ると 412 になる。保存形に版の番号の欄は足さない(手で書き換えた `draft.json`・書き込みの経路の足し忘れで版が古いままにならない)。
- **`GET .../:id`**: `If-None-Match` が一致すれば 304(本文なし。ETag・`Cache-Control: private, no-cache`・`Vary: Accept-Encoding` は付く)。
  手元の生ログを含む応答なので共有キャッシュに置かせず、ブラウザには毎回確かめさせる。
- **`GET .../`(一覧)**: 本文全体(`drafts` の中身・順・`pendingCount`)の ETag。追加・編集・マージ・見送り・件数・並び順のどれが変わっても変わる。
  一致すれば 304。
- **`PATCH .../:id`**: `If-Match` があって合わなければ **412**(`{ error, code: 'precondition-failed' }`、何も書かない)。`If-Match` が無ければこれまでどおり
  通る。`*` は一致、空・読めない値は 412。成功の応答には保存後の下書きの ETag を付ける(次の GET の ETag と同じ値)。自動の文に戻す(空で保存)も同じ。
  検査は書き込みの排他の中で行うので、同じ ETag から同時に来た 2 つの PATCH は、片方が 200、もう片方が 412 になる。順序は 入力の検証(400・題名/本文の長さの 413。ここでは ETag を見ない) → 404 → 409(未処理でない) → 412 →
  保存の 413(下書き全体が大きすぎる)・507。**見送り(`PATCH .../:id/dismiss`)は対象外**(状態の遷移で、同じ見送りの繰り返しも害が無い)。
- **`W/` を許す**: RFC 9110 の If-Match は強い比較だが、このサーバーの gzip(`hono/compress`)は gzip した応答の強い ETag を `W/"…"` に直し、
  トンネルも同じことをしうる。クライアントは受け取った値をそのまま返すので、`W/` を厳密に拒むと If-Match が使えなくなる。そのため
  `W/` を無視してダイジェストで比べる(`If-None-Match` と同じ関数)。
- **write-guard との関係**: 認証・認可(Basic 認証・`createWriteGuardMiddleware`)はルートの前に走るので、資格の無い相手には 304/412 ではなく 401/403 が返る
  (古い If-Match でも 403 のまま。ETag の一致で書き込みの可否が漏れない)。GET はもともと write-guard の対象外。
- **CORS・プロキシ**: アプリは CORS のヘッダを出さない(同一オリジン)。web は同一オリジンで `res.headers.get('ETag')` を読め、Vite の開発プロキシ・
  トンネルはヘッダをそのまま通す。
- **web**: `fetchIssueDraft` が応答の ETag ヘッダを `etag` として本文に足し、編集欄(`IssueDraftEditor`)が保存と「自動の文に戻す」の PATCH に `If-Match` で付ける。
  412 は「ほかの場所で変更されました。最新の内容を読み込み直しました。入力はそのまま残しています…」と出し、一覧と中身の問い合わせを無効にして最新と新しい ETag を
  取り直す(編集欄の入力は読み直しで置き換わらない。次の保存は変えた欄だけを新しい ETag で送る)。成功の応答の ETag は web の中身の問い合わせに置き換える
  (応答に無ければ古い ETag を捨てる)。1 件の取得の 304 はブラウザの HTTP キャッシュが処理する。
- **割り切り**: ETag が本文全体の版なので、読んだあと PATCH するまでの間に**同じ指紋の新しい発生**(回数・最後の時刻・手元の版が変わり、直していない欄の自動の文も
  作り直される)・画像の追加・harness pack の版(30 秒の TTL で読み直す)の変化があっただけでも 412 になる(利用者が直した題名・本文は変わっていなくても)。
  PATCH は排他の中で読み直した今の下書きに題名・本文を当てるので、If-Match が無くてもこれらの変化を上書きで失うことはない。読み直して保存し直せば通る。偽の 412 は上書きの取りこぼしより安全な側として許容する。

### なりすましの余地(判定の限界)

`isLocalBasicAuthRequest` は「TCP 送信元がループバック」かつ「Cloudflare トンネル転送ヘッダ
(`cf-connecting-ip`/`cf-ray`/`cf-visitor`)が無い」かつ「Host ヘッダがループバックの名前
(`localhost`/`127.0.0.1`/`[::1]`)で、ポートが listen ポートと一致」の3条件で判定する
(`local-request.ts`。決定根拠は `docs/DECISIONS-LOG.md` [.137])。既知の限界:

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
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+[^\s'"]+/gi, '<path>') // Windows のユーザーパス
    .replace(/\/(Users|home)\/[^\s'"]+/g, '<path>')
    .replace(/~\/[^\s'"]*/g, '<path>')
    .replace(/(?<![\w.~-])\/(?:private\/)?(?:var\/(?:folders|tmp)|tmp)\/[^\s'"]+/g, '<path>') // 実行ごとの一時ディレクトリ
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, '<time>')  // ISO timestamp(16進・行:列より先)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')                  // hex 断片
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7}\b/gi, '<id>')    // 7 文字の短い SHA(数字を含むものだけ)
    .replace(/:\d+:\d+\b/g, ':<loc>:<loc>')                  // line:col
    .replace(/\d+/g, '<n>')
    .toLowerCase()
    .trim();
}
// fingerprint = "B:" + source + ":" + sha256(normalizeErrorText(text)).slice(0, 16)
// source は hook 名・スクリプト名・API のパスなど「出どころ」の識別子
```

正規化は best-effort(項目 e の置き換え漏れ検出と同じく、完全性を保証しない)。目的は
「同じ症状を同じ1件にまとめる」ことであり、公開本文の安全性はここではなく5節が担う。
上の関数は設計当初の例から変えてある(理由は下の「実装との差分」)。

`source` と `catalogSlug`(と版の文字列)は題名・本文・応答にそのまま入るので、**改行・制御文字・不可視の書式文字
(3節の「1 行の検査」)を含む値は受け取りで 400** にする。これで防ぐのは行の数と見えない文字だけで、1 行でもリンク・`@`メンション・
`#`参照・`<img>` は書ける(インラインの Markdown のエスケープと公開本文の置き換えは5節、4y8q.2 の仕事)。
`source`・`catalogSlug`・版の文字列・`project.name` のホーム配下の絶対パスは、**指紋を作る前に `~/` へ畳む**(畳む形と境界の規則は
3節の「ホーム配下のパス」。**書いてある形だけ**で、コードもそれ以上は畳まない)。400 にしなかったのは、フックが自分の `$0` を
出どころに入れて報告しても受け取れ、別の利用者の同じフックが 1 件にまとまるため。パスの形かどうかはそれ以外は見ない
(`source` は `GET /api/x` のような API のパスでもよい)。`project.name` は表示用なので 400 にせず整える(3節の表)。

### 状態遷移(bdboard-4y8q.1 が実装するのは pending/dismissed だけ、posted 側は 4y8q.5)

| 受信した指紋の状態 | 動作 |
|---|---|
| 既存の下書きなし | 新規作成、`status='pending'`、`occurrenceCount=1` |
| `pending` の下書きあり | 新規作成しない。`occurrenceCount+=1`、`lastOccurredAt` 更新、`occurredProjects` に無ければ追加。手元の `envInfo` と `harnessVersionAtOccurrence` を**最後の発生のもの**に替える(m-6、下。版の無い報告では版は前の値を残す)。`titleEditedByUser`/`bodyEditedByUser` が false なら5節の関数で `title`/`body` を再生成(件数・最終発生時刻・版の反映)。直した欄があり新しいプロジェクトが加わったら、直した欄の置き換え漏れの検出をかけ直す(4y8q.3.1 レビュー m-1) |
| `dismissed` の下書きあり | 新規作成しない。`occurrenceCount+=1` のみ(エピック決定どおり) |
| `posted` かつ issue が open(4y8q.5) | 新規作成しない。「その後 N 回起きた」を表示、issue へコメントを足すボタンを出す |
| `posted` かつ issue が closed(4y8q.5) | 「再発(#N は閉じ済み)」として新規下書きを作る |

「大量発生」の下書き(下の「上限」)も同じ表に従う。`dismissed`(と、4y8q.5 までの `posted`)の
「大量発生」には、さらに丸め込まれる新規指紋が来ても `occurrenceCount+=1` だけで、題名・本文・
`foldedFingerprints`・最終発生時刻・プロジェクトは触らず作り直しもしない。

### 上限

- 1件のテキストサイズ: 手元保存の `errorTextRaw` 自体にも上限を設ける(64KB。超過分は
  末尾から切り詰める。切れ目は行の境目へ戻し、サロゲートの対を割らない: 5節「欄の端の断片」)。表示用の `errorTextHead`/`errorTextTail`(各 1000 文字以下、
  `"…(N 文字省略)…"` を間に挟む)は **この `errorTextRaw` から作る派生値であり、
  5節の置き換え(トークン等の自動置換)は `errorTextRaw` の全文に対して先に適用してから
  1000文字へ切り詰める。** 順序を逆にする(先に1000文字へ切り詰めてから置換する)と、
  トークンが切り詰め境界でちょうど分断され、置換の正規表現(20文字以上を要求するものが
  多い)にマッチしなくなり、断片が置換されないまま公開本文に残る恐れがある。`draft.json`
  全体(画像を除く)は 200KB を上限とし、超過分は末尾から切り詰める(添付画像は別ファイル
  なので影響しない)。**200KB は、ディスクに書く形(整形しない 1 行の JSON + 改行)のバイト数で測る**
  (`serializeDraft`。判定と書き込みが同じ文字列を使う)。削る順は、`errorTextRaw` の末尾 →
  `occurredProjects` の古い行(`lastSeenAt` が古い順)→ `foldedFingerprints` の古い行 → `agentNoteRaw` →
  `symptomRaw` → `causeRaw` → `preventionRaw` の末尾(自由記述 1 欄の 8000 の上限とこの削りも、切れ目を行の境目へ戻す)。
  回数と時刻は別に持つので、一覧の古い行を落としても
  数は変わらない。見送りの理由を足すとき、見送り済みの回数を足すときにも同じ判定をかける。
- 画像: 添付画像 API と同じ検査を流用 — マジックバイト判定、1枚 10MB、1下書きあたり
  20枚まで(`ATTACHMENT_MAX_BYTES`/`ATTACHMENT_MAX_COUNT_PER_TICKET` と同じ定数を共有するか、
  `issue-report` 用に複製して同じ値を持たせる)。終端の(見送り・投稿済み。`dismissed`・`posted`)下書きへの追加は 409、
  ディレクトリ全体の合計が上限を超えるときは 507(下の「保持期限と合計容量」)。
- 新規下書きの件数: **1時間20件まで(種別 A/B/C をまたいだ合計)**。実装は UTC の暦時間バケツ
  (`mass-occurrence:<kind>:<yyyy-mm-ddTHH>`)で数える。21件目以降の新規指紋は個別の下書きを
  作らず、そのバケツの「大量発生」下書きへ丸め込む(`occurrenceCount` を増やし、`localOnly` に
  丸め込まれた元の指紋一覧を追記する。公開本文は「この時間に N 件の類似しない問題が集中発生」
  という一般的な文面に留め、個別の詳細は出さない)。暦時間区切りは実装が簡単な分、境界をまたぐ
  瞬間だけ実質的な上限が緩む(60分の壁時計窓ではなく1時間区切り)。厳密なスライディングウィンドウ
  が要るなら実装時に変更してよい(小さな決め事なので本ドキュメントではブロックしない)。

### 保持期限と合計容量(bdboard-00qh)

暴走した hook やエージェントのループで、下書きと画像が無制限に増えないようにする。方針は**利用者がまだ済ませていない
下書きは自動では消さない**こと。コードの置き場所: 方針 `src/domain/issue-draft-retention.ts`、いつ走らせるか・失敗の扱い
`src/application/issue-report/issue-draft-retention.ts`、測る・消す `src/infrastructure/fs/fs-issue-draft-footprint.ts`。

**保持期限(30 日)**

- 消すのは**終端の状態**(`dismissed`、と `posted`。`posted` になる経路は 4y8q.5 まで無い)で、**最終更新から 30 日を超えた**
  下書きだけ。ちょうど 30 日は残す(「超えた」)。画像は下書きのディレクトリごと消える。`pending`(開いている)下書きは、
  何日たっても自動では消さない。
- 「最終更新」は `draft.json` の mtime。保存のたびに進む: 見送り(`dismissed` にする保存)も、見送り済みへ回数だけ足す
  受け取り(4節の状態遷移)も保存なので、見送ってから 30 日ではなく**最後に保存されてから 30 日**。繰り返し起きている
  見送り済みの下書きは残り、放置された見送り済みだけが消える。draft.json にこのための欄は足していない(既存の下書きの
  移行が要らない)。mtime が進む方向のずれ(コピーで日付が新しくなる)は消すのが遅れるだけで安全側。
- 消した後に同じ指紋が来れば、新しい `pending` の下書きとして作られる(「見送ったのにまだ起きている」が再び見える)。
- **走らせる時**: サーバー起動時(`wireIssueReports` が待たずに呼ぶ)と、受け取りのついで(1 時間に 1 回まで)。掃除は受け取りと
  同じ mutex の内側で 1 本ずつ流れるので、消している最中に同じ下書きへ書き込みは来ない。時計(`now`)と間隔
  (`retention.pruneIntervalMs`、既定 1 時間)、期間(`retention.retentionMs`、既定 30 日)は `createIssueDraftService` の
  依存として差し替えられる(テストは注入した時計で確かめる)。時計が戻った(前回の掃除・棚卸しより前の時刻になった)ときは、
  間隔が過ぎたものとして走らせる(戻った分だけ掃除や測り直しが止まらない)。
- **掃除の棚卸しは、受け取りの索引も作る**(bdboard-xvo2): 棚卸しは状態を知るためにすべての `draft.json` を読んで parse する
  ので、そのついでに索引の材料(id・指紋・最初に起きた時刻・状態。`DraftSurvey.indexSeed`)を集め、掃除が期限切れを消し終えたあと、
  まだ索引を読んでいなければ、消せた下書きを除いて索引にする(`onPruned` -> `indexCache.seed`)。起動直後は、掃除の棚卸し(全件を
  読む)と最初の受け取りの索引づくり(全件をもう一度読む)が同じ mutex の中で続いて 2 回分かかっていたのを、1 回にする。掃除が
  受け取りより先に終わっていれば、最初の受け取りは全件を読まない。材料は `scan()` と同じ集合・同じ `complete` の判定(あとで読める
  かもしれない理由で飛ばした下書きがある、または `draft.json` の stat があとで通るかもしれない理由で失敗した(ENOENT と、ENOTDIR など恒久の失敗は除く)ときは
  `complete: false`)で、
  欠けているとき・材料を付けない保存先・棚卸しが失敗したときは索引を置かず、従来どおり最初の受け取りが `scan()` で読む。
  すでに読んだ索引は、後から来る掃除の棚卸しでは上書きしない(書いた分を足し続けている索引が正)。容量の測り直し(`ensureRoom`)の
  棚卸しは索引を作らない。割り切り: 索引を取る時点が、最初の受け取りか件数の問い合わせの時点から、起動時の掃除の終わりに早まる。起動から最初の
  受け取りまでのあいだに、サーバーを通さず手で `draft.json` を足し引きしても、索引には反映されない。影響は 2 つだけ: 手で戻した
  下書きと同じ指紋の報告が併合されず重複した下書きになること(再起動で直る)と、未処理件数がずれること(一覧を読むと合う。
  上の「未処理件数」)。手で戻した
  下書きの一覧・表示・見送り・編集は、索引を通らないので普通に効く。これは「索引はサーバーの外の変更を追わない」という既存の
  割り切り(下の「キャッシュ済みの完全な索引のあと」の前提)と同じで、サーバー経由の書き込みはすべて mutex の内側で索引に反映される。
- **1 時間に 1 回の掃除を引き当てた受け取りは、棚卸しのぶん遅れる**: 棚卸しは mutex の内側で走るので、下書きが数万件だと
  その受け取りの応答が 1〜2 秒かかり、クライアントの 1 秒の待ち(9 節)を超えることがある。クライアントが諦めても、サーバーは
  その報告を保存する(取りこぼしにはならない。再送しなくてよい)。
- **失敗しても受け取りを落とさない**: 掃除の失敗(棚卸しの失敗、1 件の削除の失敗)は警告を出して先へ進む。警告は N5 と同じ
  形で、**code と id だけ**(`issue draft survey failed (EIO)`、`issue draft <id> could not be removed (EBUSY)`)。パスも
  エラーの message も出さない。失敗した掃除は次の 1 時間後まで再試行しない。棚卸しのベースディレクトリの `readdir` は、
  N5 の画像の `readdir` と同じく再試行せず、最初の失敗で投げる(掃除は警告して終わる)。

**合計容量の上限(既定 1 GiB)**

- issue-drafts ディレクトリ全体(各下書きの `draft.json` と `images/` 直下のファイルの合計)の上限。既定は
  `ISSUE_DRAFT_DIR_MAX_BYTES` = 1 GiB で、`retention.maxTotalBytes` で差し替えられる。根拠: 画像の上限(1 枚 10MB × 20 枚)で
  1 下書きが最大 200MB、`draft.json` は最大 200KiB なので、1 GiB は「画像を目いっぱい付けた下書き約 5 件」か「最大の
  `draft.json` 約 5,000 件」に当たる。人が振り分ける量(普通は数十件、1 件数 KB〜数十 KB)よりずっと大きく、暴走が手元の
  ディスクを埋める前に止まる大きさ。
- **受け取りか画像の追加が上限を超えるときは、まず終端の下書きを古い順(最終更新、同じなら id)に消して空ける。** 空きが
  足りれば受け取る。**終端の下書きを全部消しても足りないときは、何も消さずに断る**(その書き込みはどのみち入らないので、
  消しても無駄)。断るときは **HTTP 507**、本文は `{"error":"issue draft storage is full","code":"storage-full"}`。開いている
  (`pending`)下書きは消さない。507 は再送で直らない(利用者が見送るか手で消すまで続く)ので、クライアントは再送しない。
  手で消したあとにすぐ受け取らせたいときは、サーバーを再起動する(起動時の掃除が待たずに全件を測り直す。再起動しなくても、
  最長 1 時間で次の掃除の棚卸しが気づく。下の「上限に張り付いているあいだは…」)。
  見送り(`PATCH .../:id/dismiss`)は上限で断らない(見送ると、空けられる下書きが増える)。
- **今書いている下書き自身は、空ける相手にしない。** 見送り済みの下書きへ回数だけ足す受け取り(回数が 9→10 のように桁が増えて
  `draft.json` が 1 バイト増えるとき)や、大量発生の下書きへの丸め込み、その下書きへの画像の追加で、ちょうど満杯でも、自分を
  消して画像を失ってから `draft.json` だけ書き戻すことはしない(ほかの終端の下書きを消して空け、空かなければ 507)。
- **空ける途中で 1 件が消せないとき**(EBUSY など)、選んだほかの下書きはすでに消えている。それでも足りなければ、その受け取りは
  507 になる(消えた分は戻らない。消えたのは終端の下書きだけで、どのみち期限が来れば消えるもの)。「何も消さずに断る」のは、
  終端の下書きを全部消しても足りないと**選ぶ前に分かる**ときだけ。警告は `issue draft <id> could not be removed (EBUSY)`。
- **測り方(受け取りごとに歩かない)**: 起動時の掃除と、1 時間ごとの掃除の棚卸し(`survey`)で実測の合計を取り、そのあとの
  書き込みの差分(新しい `draft.json` の大きさ - 上書き前の大きさ、画像は追加した大きさ)を足して保つ。受け取りごとの確認は
  この合計との足し算だけ。**合計が上限を超えそうなときだけ**実測し直し、それも **1 分に 1 回まで**(上限に張り付いて断り続ける
  暴走が、受け取りごとに全件を測り直さないように)。その 1 分の間は、直近の棚卸しの下書き一覧(消したものを除く)から消す
  下書きを選ぶ。
- **上限に張り付いているあいだは、測り直しの間隔を倍々に伸ばす**(bdboard-krvf): 測り直したのに空けられなかった(終端の
  下書きが無い・あっても足りない・1 件が消せない・空けられるのが今書いている下書き自身だけ、のどれか)たびに、次の
  測り直しまでの間隔を 1 分 → 2 分 → 4 分 …と倍にして、**1 時間**(`ISSUE_DRAFT_RESURVEY_GAP_MAX_MS`、
  `retention.resurveyGapMaxMs`)で止める。空けられない測り直しは結果が変わらないのに、棚卸しの間は mutex を握り続けて受け取りを
  待たせるため(下の実測)。`retention.resurveyGapMs` を 0 にすると延ばさない。
  - **間隔が 1 分に戻るのは次の 3 つのときだけ**: (1) 容量の確認(`ensureRoom`)が測り直しや直近の棚卸しの一覧から収められた(外で
    消されて空いていた、または終端の下書きを消して空けた)、または測れず通した(fail-open)とき。(2) **見送ったあと**(見送りで空けられる下書きが増える。`noteFreeableDraft`。投稿済みにする経路を
    足すときも呼ぶ)。見送りのあとは、最後の測定から 1 分たっていれば次の確認で測り直して、見送った下書きを消して受け取る。
    (3) **起動時と 1 時間ごとの掃除が空きを見つけたとき**: 期限切れを 1 件以上消せた、または実測の合計が棚卸し前に持っていた合計
    (書き込みの差分を足し続けたもの)より小さい(= 外で手で消された)とき。何も空いていない掃除では戻さない(毎時戻すと、
    1 時間に 6 回測り直す元の木阿弥になる)。
  - **戻らない**: 合計に余裕があってそのまま通した確認(早い道。小さい書き込みが通っても、大きい書き込みが張り付いているのは
    変わらない)と、間隔の中で測らずに断っただけの確認。
  - 伸びている間に外から手で消されたことに気づくのは、次の測り直しか 1 時間ごとの掃除の棚卸しのとき(最長 1 時間)。すぐ
    気づかせるには、サーバーを再起動する(起動時の掃除が待たずに測り直す)。
- **棚卸しのコスト**: 下書き 1 件につき `stat`(draft.json)・`readdir` と `stat`(images/)・`readFile`(状態を知るため)。64 件ずつ
  並べて開く。再帰では歩かない。**実測**(bdboard-krvf、macOS・SSD・OS のキャッシュが温まった状態、1 GiB に 100 バイト足りない
  `draft.json` 5,243 件 × 約 200KiB): 棚卸し 1 回は通常の形(長い生ログ 1 つ)で約 3.3〜3.6 秒、`occurredProjects` 100・
  `foldedFingerprints` 200・自由記述 8,000 文字 × 4 まで詰めた形で約 6.5〜8.5 秒。時間の大半は `readFile`・`JSON.parse`・
  zod の検証で、件数にほぼ比例する(525 件で約 0.33 秒)。その間、同じ mutex の受け取りは待つ(クライアントの 1 秒の待ち、
  9 節を超える)。サーバー起動直後の最初の受け取りは、以前は掃除の棚卸しと受け取りの索引づくり(全件をもう一度
  読む)が続いて、ほぼ 2 倍かかった(実測 8〜14 秒)。棚卸しが索引の材料も返すようにした(bdboard-xvo2、上の「掃除の棚卸しは、
  受け取りの索引も作る」)ので、棚卸しの 1 回分になった(同じ 5,243 件・約 1 GiB の通常の形で、起動直後の掃除と最初の受け取りを
  並べて 10.8〜11.1 秒 → 5.0 秒、`draft.json` の読み出しは件数の 2 倍 → 1 倍)。掃除が先に終わっていれば最初の受け取りは待たない。
- **大きさを測れなかったとき**: 画像ディレクトリの `readdir`・`stat` が ENOENT 以外で失敗したら(EIO など)、その場所は
  **0 バイトで数え**(測れない大きさを最悪値と見なすと、一時的な失敗で受け取りが断られ報告が失われる)、`unmeasured` に code を
  積んで、1 回の警告にする(`issue draft sizes are undercounted: N location(s) could not be measured (EIO)`)。その下書きは
  状態で扱う(読めていれば期限で消えうる)。測る全体が失敗したとき(棚卸しが投げる)、上限の確認は**通す側**(fail-open)に倒す:
  測れないことで報告を失うより、上限を少し超えるほうが害が小さい。それまでに一度測れていても、前回の合計や下書きの一覧は
  捨てる(古い合計で断り続けない)。次に測り直すのは 1 分後。数えないもの: 保存の途中で落ちたときの一時ファイル
  (`draft.json.*.tmp`、最大 200KB。下書きごと消せば消える)と、`images/` の下の入れ子のディレクトリ(保存層は作らない)。

**画像は pending の下書きにだけ(409)**

- `dismissed`(と `posted`)の下書きへの画像の追加は **HTTP 409**、本文は
  `{"error":"images can only be added to a pending draft","code":"draft-not-pending","status":"dismissed"}`。判定の正はサービス
  (mutex の内側、画像の枚数と上限の確認より前)。ルートも、最大 10MB の本文を読んでデコードする前に、すでに読んでいる下書きの
  状態で先回りして同じ 409 を返す(サービスの判定は残る)。画像は期限が来れば下書きごと消えるので、消える下書きに画像だけ
  増やさせない。
  枚数の上限(1 下書き 20 枚)の 409 は従来どおり。

**読み取りの失敗の扱い(N5)との関係**

- **`draft.json` が読めない下書きは、どの種類のエラーでも消さない**(状態を知らないため)。恒久(ENOTDIR・EISDIR・
  非 win32 の EACCES・不正な JSON・形の不正・id の食い違い)、ファイル単位(EBUSY、win32 の EPERM・EACCES)、未列挙(EIO など)
  は、棚卸しで `known`(状態と mtime)なしになり、期限でも容量でも選ばれない。`draft.json` が無い(画像だけの)ディレクトリも
  同じ。大きさは数える。
- プロセス全体の失敗(EMFILE・ENFILE・EAGAIN)は、N5 のとおり読み出しが再試行して使い切ると投げる。棚卸しも投げ、掃除は
  警告(`issue draft survey failed (EMFILE)`)を出して**何も消さずに**終わる。
- 掃除そのもの(何を消すか)は一覧(`scan`)の `complete` には関わらない。掃除が作る索引(上の「掃除の棚卸しは、受け取りの
  索引も作る」)は `complete` に従う: 欠けているときは置かず、最初の受け取りが `scan()` で読む。索引ができたあとは従来どおり、
  `get` が undefined なら「ディスクに無い」として作り直す(消した下書きと同じ指紋が来れば新しい下書きになる)。

**索引ファイルは作らない(`scan()` と `loadIndex` の全件読みの判断)**

- 数: 新規は最大 **1 時間 23 件**(個別 20 + 種別 A/B/C の「大量発生」3)なので、無人で暴走が続いたときに 30 日で増える
  下書きは最大 **23 × 24 × 30 = 16,560 件**。終端の下書きは 30 日で消えるので、利用者が月に 1 回振り分け、暴走が続く最悪でも
  定常で約 3.3 万件(開いている 1 か月分 + 見送った 1 か月分)。
- 計測(開発機、macOS・SSD、全件を実ファイルで置いて): 1 件 1.3KB(下書きの最小)の 16,560 件で `scan()` は 0.5〜0.8 秒、1 件 7.2KB
  (エラー文 4KB)で 0.9〜1.1 秒。棚卸し(`survey`)は 0.55 秒(2 回目以降。初回 1.0 秒)。ほぼ件数に比例するので、3.3 万件で約 2 秒、
  開いている下書きが 1 年たまった 20 万件で約 10 秒。`ulimit -n 256` でも 16,560 件の `scan()` は EMFILE なしで通った(計測は、`drafts` だけを返していた旧 `list()` と同じ読み。bdboard-ydrl で `list()` は消した)。
- 判断: **索引ファイルは作らない。** 呼ぶ回数は、全件を読んで索引を作るのは起動後の 1 回(起動時の掃除の棚卸しが作る。掃除が
  失敗した・欠けた一覧のときだけ、最初の受け取りの `loadIndex` が読む。欠けた一覧は読み直す)、
  棚卸しは 1 時間に 1 回(と上限の近くで 1 分に 1 回まで)、`scan()`(画面の一覧は `listWithPendingCount()` 経由)は利用者が画面を開くとき。普通の量(数十件)では無視でき、
  30 日の最悪(16,560 件)でも 1 秒前後。索引ファイルは `draft.json` との二つ目の真実になり、書き込みの途中で落ちたとき・
  読めない下書き(N5)・手で消したときに食い違う分、全件読みより壊れ方が増える。件数が数万を超えて `scan()` が数秒かかるように
  なったら、そのとき作る(見直しの目安: `scan()` が 3 秒を超える、または下書きが 5 万件を超える)。

**この変更で残すもの**

- `posted` の下書きも 30 日の最終更新で消える。4y8q.5 が「`posted` かつ issue が open のとき、その後の発生を表示する」を
  入れるとき、open の issue に結びついた `posted` を消してよいかを決め直す(`issueNumber` が消えると再発の紐づけが切れる)。
- 一覧(`GET .../drafts`)の応答には `updatedAt` を足していない。画面(4y8q.3)が「あと何日で消える」を見せたくなったら足す
  (4y8q.3.1 でも足していない: 4y8q.3 の一覧の行は種類・題名・プロジェクト・回数・最後に起きた時刻で、消えるまでの日数は出さない。
  `updatedAt` は `draft.json` の mtime で下書きの欄に無く、足すには保存層の一覧で stat が要る)。

### 実装との差分(bdboard-4y8q.1、PR #859)

設計(本ドキュメント)と実装の食い違いと、実装中・レビューで決めたことの記録(4y8q.11 の受け入れ基準:
食い違いは実装側の PR で書く)。設計が優先で、ここに無い点は設計どおり。

**設計の文面からの差(PR 本文の 8 件)**

| # | 項目 | 実装 |
|---|---|---|
| 1 | 1時間20件の数え方 | **種別 A/B/C をまたいだ合計**で 1 時間(UTC の暦時間バケツ)に 20 件。設計の文面が種別ごとか合計か曖昧だったので、枠を小さく保つほうを選んだ。「大量発生」は種別 × 時間で 1 件ずつ、20 件には数えない。**注意**: 合計なので、ある 1 種別が 20 件を使い切ると、同じ時間の他の種別の新規指紋は、その種別の個別の下書きが 1 件も無くても「大量発生」に丸められる(1 種別がほかを飢えさせうる)。種別ごとの枠にするかは、実際に起きてから決める |
| 2 | 題名・本文 | 公開してよい題名・本文を作る 4y8q.2 がまだ無いので**暫定の組み立て**: 種別・名前(source / catalogSlug)・回数・時刻・版数だけ。症状・原因・エラー文・プロジェクト名は入れない。4y8q.2 が入ったら `domain/issue-draft-build.ts` の `finalize` を差し替える |
| 3 | 題名・本文の編集(`PATCH .../:id`) | 4y8q.3 に回した。画面 API はチケットどおり一覧・取得・見送りだけ。`titleEditedByUser` / `bodyEditedByUser` は保存形式と再生成の判定には入っている。**bdboard-4y8q.3.1 で入れた**(3節「閲覧・編集(PATCH)側のフィールド範囲」) |
| 4 | 画像の追加 | 受け取りの本文を 1 MiB に抑えるため、**1 枚ずつ別のエンドポイント**(`POST .../:id/images`) |
| 5 | `normalizeErrorText` の順 | 時刻の置換を 16 進・行:列の置換より**先**に行う。得られるのは、小数秒ありの `…56.789Z` と無しの `…56Z` が同じ値になること(同じ書式どうしは、どちらの順でも数字が `<n>` になって揃う) |
| 6 | 64KB の生エラー文 | **文字数**で数え(64Ki 文字)、バイトの 200KB を別に掛ける |
| 7 | `posted` への再発 | 4y8q.5 までは、回数を失わないよう `dismissed` と同じく回数だけ足す。`posted` になる経路はこの PR には無い |
| 8 | 見送り(`PATCH .../:id/dismiss`) | 通常の write-guard(ローカル直、または強パスワード + セッション)。ローカル直アクセス限定にしたのは受け取りと画像追加だけ (画像の取得は bdboard-4y8q.3.2 でローカル直アクセス限定にした) |

**レビュー(Opus、2026-10-04)で決めたこと**

- **1 件の取得はトンネルでは絞る(M-1)**: 3節の「1 件の取得はトンネルでは絞る」。`restricted: true`。
- **ローカル限定のテスト(M-2)**: 画像 POST の「トンネルは 403」のテストは、書き込み許可つきの設定
  (`TUNNEL_WRITE_ALLOWED`)で書く。許可なしだと汎用の write-guard が必ず 403 を返し、`localOnlyGuard` を
  外してもテストが通ってしまう(外すとテストが落ちることを確認済み)。
- **`normalizeErrorText` の拡張(M-3)**: UUID(4 文字の 16 進グループは `{8,}` の規則では残る)、数字を含む
  7 文字の 16 進(短い SHA)、一時ディレクトリ(`/private/var/folders/…`・`/var/folders/…`・`/var/tmp/…`・`/tmp/…`)、
  Windows のユーザーパスを足した。実行のたびに値が変わるものを 1 件にまとめるため。英字だけの 7 文字
  ("defaced" など)は単語として残す。
- **見送り・投稿済みの「大量発生」(m-2)**: 通常の下書きと同じ「回数だけ足す」にした(4節の状態遷移の下)。
- **`source` / `catalogSlug` は下書き自身の欄**(m-1): 指紋から切り出し直さない。これらと版の文字列、見送りの
  理由は、改行・制御文字を含むと 400。以前の「自由記述は一切入らない」という説明は正しくなかった
  (名前と版は呼び出し側の値がそのまま入る)ので改めた。パスの形かどうかは見ない。
- **200KB を硬い上限に(m-3)**: ディスクに書く形で測り(整形しない 1 行)、`occurredProjects` と
  `foldedFingerprints` も古い行から落とす(4節「上限」)。
- **小さな点(nit)**: 見送りの理由は 1 行(改行は 400)。読めない・壊れた下書き(権限、ディレクトリでない、不正な
  JSON など)は警告して一覧と受け取りから飛ばす(同じ下書きの同じ理由の警告は 1 回)。受け取り本文の上限
  (1048576 バイト)と見送り本文の上限(16384 バイト)はリテラルの数値でテストに固定した。画像の枚数は、
  サーバーが採番した名前の画像だけ数える(`.DS_Store` などは数えない)。

**再レビュー(2026-10-04、2 回目)で決めたこと**

- **CI(verify-windows)**: Windows には POSIX のパーミッションが無いので、0700/0600 のテストは Windows では
  実行しない。「下書きの id が普通のファイル」(ENOTDIR)の行も、Windows は ENOENT と報告して警告にならない
  ので POSIX だけで確かめる。
- **`source` / `catalogSlug` のパス(F2)**: 400 ではなく**受け取りで `~/` に畳む**ことにした(3節の表)。
  トンネルの読み手が見る欄の全部も3節に書いた。
- **`sourceTicketRef`(F3)**: ticket id の形だけ受ける。6節の手順 8 で、実行側も `--` を前置する(4y8q.4)。
- **時刻の形(F4)**: `firstOccurredAt` / `lastOccurredAt` / `firstSeenAt` / `lastSeenAt` は ISO 8601 の UTC で、
  末尾が `Z` の形(`2026-10-04T12:00:00.000Z`)でなければ「使えない下書き」として飛ばす。`+09:00` のようなオフセット付きは
  不可(ミリ秒は付いていても省いてもよい)。以前は形の合わない値が受け取りの索引づくりで例外を起こし、以後の受け取りが
  すべて失敗した。
- **不可視文字(N2)**: ゼロ幅・双方向制御・BOM も 1 行の検査で弾く。孤立したサロゲートは見ない(4y8q.2 で扱う)。
- **200KB を超える下書き(N3)**: 縮められる欄を削り切っても超える下書きは、保存層が書かずに投げる。題名・本文の
  長さは入口で抑える(3節、4y8q.3 の仕事)。
- **読み取りの失敗の扱い(N5、bdboard-r50m で改めた)**: draft.json の読み出しのエラーを 4 つに分ける
  (`issue-draft-file-reader.ts`)。再試行は、最大 4 回(最初の 1 回 + 再試行 3 回。再試行の前に 20・40・80ms 待つ。
  合計 140ms)。試行のあいだでコードが変わったときは、**最後に起きたエラーの種類**で扱いが決まる(EMFILE のあとに
  EBUSY で終われば飛ばし、EBUSY のあとに EMFILE で終われば投げる)。
  - **プロセス全体**(EMFILE・ENFILE・EAGAIN。ファイルを開きすぎ・資源の一時的な不足): どの下書きを読んでも起きる。
    再試行して、使い切れば**元のエラーを投げる**(一覧・取得・受け取りが失敗する)。1 件ずつ飛ばすと、一覧のほとんどが
    空になるので飛ばさない。
  - **ファイル単位**(EBUSY、**win32 だけ** EPERM・EACCES): そのファイルを他のプロセス(OneDrive などの同期
    クライアント、アンチウイルス)が握っている間だけ起きる。同じように再試行し、使い切れば**その 1 件だけを警告つきで
    飛ばし**(`unreadable (<CODE>)`)、ストアの `scan()` が `complete: false` で知らせる(受け取りの索引はキャッシュ
    されない)。`get()` も同じ扱いで undefined を返す。投げると、握られたままの 1 件のせいで一覧と全部の受け取りが
    500 になり、クライアントは 1 秒で諦めて再送しない(9節)ので報告が失われる。Windows の ACL による本当の拒否は、
    #859 では飛ばしていたので、投げると退行にもなる(ACL の拒否と一時的なロックは見分けられない)。
  - **恒久**(ENOTDIR・EISDIR、**win32 以外**の EACCES・EPERM、不正な JSON・形や時刻の不正・id の食い違い):
    再試行せず、警告つきでその 1 件を飛ばす。一覧は欠けていない扱い(受け取りの索引はキャッシュされる)。
  - **未列挙**(上のどれでもない: 不良セクタの EIO・ELOOP・2 GiB 超の ERR_FS_FILE_TOO_LARGE・`code` の無いエラーなど):
    再試行せず、その 1 件を警告つきで飛ばし、一覧も受け取りも止めない(以前は一覧と全部の受け取りが 500 になり、
    手でファイルを直すまで戻らなかった)。直るかもしれないので `complete: false` で知らせ、受け取りは**その回の索引を
    キャッシュしない**(その回の受け取りには使う。次の受け取りが全件を読み直す)。
  - 割り切り(ファイル単位・未列挙のエラーで飛ばしている間): その下書きの指紋が新規として作り直され、重複しうる。
    たとえばマージ先の下書きが 140ms をわずかに超えて握られていると、受け取りは 500 を返す代わりに、重複した下書きを
    作る(EIO と同じ割り切り)。1 時間あたりの新規件数を数え漏らすことがある(上限 20 件を飛ばした数だけ超えうる)。
    受け取りごとに全件を読み直す。
  - 割り切り(ファイルが握られ続けている間の待ち): 受け取りのたびに再試行の待ち(約 140ms)を払う。受け取りは
    mutex で 1 本ずつ直列に流れるので、約 7 件以上が重なるとクライアントの 1 秒の待ち(9節)を超えうる。ただしサーバーは
    受け取った報告を保存する(クライアントの応答だけが間に合わない)。
  - 割り切り(キャッシュ済みの完全な索引のあと): 既知の下書きがあとから読めなくなると、`get()` が undefined を返す。
    サービスは「手で消された」ものとして新しい下書きを書き、キャッシュされた索引は再起動まで新しい方を指す。
  - 再試行の範囲: **draft.json の読み出しだけ**。ベースディレクトリの `readdir` と画像の `readdir`・`stat` は再試行せず、
    最初の EMFILE・EBUSY で投げる(ここは直していない)。
  - 警告には id と理由(code)だけを出し、保存先のパスもエラーの message も出さない。同じ下書きの同じ理由は 1 回。

**再レビュー(2026-10-04、3 回目)で決めたこと**

- **ホーム配下のパスの形(R3-1)**: 畳む形と境界の規則を広げ、コードと同じ一覧を3節の「ホーム配下のパス」に書いた
  (WSL の `/mnt/c/Users`・Git Bash の `/c/Users`・Cygwin・`/System/Volumes/Data/Users`・`/Volumes/<ディスク名>/Users`・
  `/var/home`・`/usr/home`・`` ` [ , ; | < { `` の直後・`\\?\C:\Users`・`\\wsl$\<distro>\home`・小文字の `/users/`)。名前の終わりは
  区切りか空白・引用符・文字列の終わり(以前は区切りか文字列の終わりだけで、`"/Users/u"` と `/Users/u --flag` を取りこぼした)。
  割り切り: Windows の名前は空白を許す(`John Smith`)ので `bash C:\Users\u --flag` は `bash ~/` になり、`/Users/Shared`・
  `C:\Users\Public`・`/home/linuxbrew` も畳まれる(引数や共有の場所より、ユーザー名を残さないことを優先)。`GET /Users/42` のような
  行頭・空白の直後の形も区別できず畳まれる。`GET /api/home/x` と `POST /api/Users/42` は触らない。
- **応答でも畳む(R3-1)**: トンネルの `GET drafts/:id` と一覧・受け取り・見送りの応答は、`fingerprint`・`title`(詳細はさらに
  `catalogSlug`・`source`・`body`・`occurredProjects[].name`・版の文字列・`harnessVersionAtOccurrence`)にもう一度 `foldHomePaths` を
  かける。保存先へ生のパスが直接書かれていても出ないことを、ストアへ直接書いた下書きで確かめている。
- **`project.name` と版の文字列(R3-2)**: 受け取りで `project.name` と `envInfo` の各文字列にもホーム配下のパスの畳み込みをかける。
- **1 行の検査の集合(R3-3)**: 文字を 1 つずつ並べる代わりに Unicode の分類(Cc・Cf・Zl・Zp)とハングルの埋め字で決める。
  ALM・単語結合子と不可視の演算子・注釈記号・タグ文字・ソフトハイフン・U+180E が新たに不可。異体字選択子(IVS を含む)・
  濁点の分解形・全角スペースは許す。タグ文字は区画全体(U+E0000–E007F)を閉じる(Cf でない割り当て前の番号も含める)。
- **表示用の欄は弾きすぎない(R3-4)**: 識別子(`source`・`catalogSlug`・版の文字列・`sourceTicketRef`)は厳密に 400。`project.name` は
  整えて受ける(第 3 回の時点では「取り除いてから畳む」としたが、取り除くとパスの手前の区切りが消えて畳めない場合があったため、
  第 4 回で「改行・タブなどは空白に替えてから、残りを取り除いて畳む」に改めた。見えない文字でパスの形を崩した
  `/Us<ZWSP>ers/…` も畳まれる。空なら 400)。`dismissReason` は ZWSP と BOM を取り除き、ZWJ・ZWNJ を許す。
  400 の応答に `details` を付けたのは第 3 回の変更だが、zod の既定の文言は入力の値を含むため、第 4 回で外した(下の R4-2)。
- **画像の stat(R3-5)**: 画像の数え上げ・一覧で、`readdir` のあとに消えたファイル(ENOENT)だけ飛ばし、EMFILE・EIO などは
  投げる(飛ばすと少なく数え、上限を超えて足せてしまう)。
- **時刻の形(R3-6)**: ISO 8601 の UTC で末尾 `Z` と明記した(オフセット付きは不可)。

**再レビュー(2026-10-04、4 回目)で決めたこと**

- **`project.name` は、区切りになる文字を空白に替えてから整える(R4-1)**: 第 3 回の「取り除いてから畳む」は、改行・タブ・U+2028/2029・BOM を取り除くと
  パスの手前の区切りが消えて前の語に貼り付き、畳まれない(`proj<TAB>/Users/u/proj` が `proj/Users/u/proj` のまま保存された)。
  これらは取り除かず空白に置き換え、残りの弾く文字を取り除いてから畳み、空白の連なりを 1 つにする(3節の表)。
- **400 に `details` を付けない(R4-2)**: 受け取り・見送りの 400 は固定の `{"error":"invalid request body"}` だけにする。zod の既定の文言は
  入力の値をそのまま含み(`z.enum` の不一致は `received '<値>'`)、`{"kind":"/Users/u/secret"}` の値が 400 の本文に戻った。
  受け取り(POST drafts)は `localOnlyGuard` の後ろ(トンネルは 403)にあるので、理由は「トンネル越しに値が戻る」ことではなく、
  **書き込んだ側へ入力の値をそのまま返さない・応答を残すログへ入力の値を残さない**こと(見送りの PATCH は通常の write-guard で、
  強パスワード + セッションのトンネルからも書けるが、同じく書き手へ値を戻さない)。どの欄が落ちたかを返す利点より、これを取る
  (文言は第 4 回の記録を bdboard-4lea で直した)。
- **名前は区切りで止まる(R4-3)**: ホーム配下のパスの名前に、バッククォート・`:` `;` `,` `|` `<` `>` `)` `[` `]` `{` `}` `=` と改行を含めない(3節の「ホーム配下のパス」)。
  以前は `/home/u:/home/u/bin` が `~/home/u/bin`(1 つ目の名前が `:` をまたいで 2 つ目の `/home` まで飲み込んだ)、
  `C:\Users\u;C:\Users\u\bin` が `~/Users\u\bin` になり、Windows の名前が改行も受けるため、複数行の本文では畳んだ行以降を消した。
  Windows の名前の半角スペースは残す(`John Smith`)。
- **指紋の畳み方(R4-4)**: 種別の印の形(`A:` `B:` `C:` `mass-occurrence:`)に一致するときだけ印を分けて後ろを畳み、そのあと全体をもう一度畳む。
  最初の `:` で切っていたため、印の無い指紋や `C:\Users\u\x:abcd` のようなドライブ文字のパスは畳み損ねていた。
- **畳み込みの対象の言い直し(R4-5)**: `toSummaryDto` の畳み込みは、ローカル直アクセスにも掛かる(一覧・受け取り・見送り)。冪等なので
  受け取りで書いた値は同じ値で返り、違うのは保存先へ直接書かれた生の下書きだけ(3節の「多層防御」)。コードは変えていない。
- **見送りの理由の見える文字(R4-7)**: ZWSP と BOM を取り除いたあと、空白と ZWJ・ZWNJ だけが残るもの(`"\u200D"` など)は 400。
- 見送ったもの(R4-6): `//Users/u`・`#!/Users/u`・`-I/Users/u`・`file://localhost/Users/u`・全角の句読点の直後・`/data/home/u` のような形は、
  3節に書いた形以外は見つけない方針どおり、畳む形を広げない。

**第 4 回の指摘の残り(bdboard-4lea、#859 の後始末)**

- **Windows の名前は、空白か `(` の直後が次のパスの頭なら終える(必須の修正)**: `cd C:\Users\u && node C:\Users\u\x.js` は `cd ~/:\Users\u\x.js` のように、
  次のパスの頭を名前に飲み込んで次のユーザー名が残った。空白か `(` の直後がドライブ文字(`X:\` `X:/`)か `/` `\`(間に `(` があってもよい)なら、その手前で名前を終える
  (`John Smith`・`bash C:\Users\u --flag` → `bash ~/` は変えない)。3節の「ホーム配下のパス」。
  再レビューで `(` の穴(`C:\Users\u (D:\Users\v\x)`・`C:\Users\u(D:\Users\v)`・`cwd C:\Users\a (C:\Users\a\x.js:1:2)`)が見つかり、
  `(` を `PATH_END` の止まる文字に加え、Windows の名前の `[ (]` と、POSIX・WSL の名前の `(` に同じ条件を付けた。
- **`` ` `` `)` `{` `}` `'` は名前に入れず、既知の取りこぼしと書いた**: 名前の途中にあると手前までしか畳まない(`O'Brien` は `~/'Brien`)。
  R4-3 の名前の終わりの記号(`C:\Users\u)rest` → `~/)rest` など)と両立しないため(3節の「既知の取りこぼし」)。
  止まる文字の一覧の `[` と `{` の書き漏れは直した(コードは最初から止まる)。
- **`project.name` の空白に見える文字**: ハングルの埋め字(U+115F・U+1160・U+3164・U+FFA0)と U+180E は取り除かず空白に替える
  (`proj<U+3164>/Users/u/proj` → `proj ~/proj`)。ZWSP(U+200B)・WORD JOINER(U+2060)・ソフトハイフン(U+00AD)は、画面で何も
  見えないので、これまでどおり**取り除く**ことにした(空白に替えると `/Us<ZWSP>ers/u` の形崩しが畳めなくなり、既存のテストも
  取り除くことを前提にしている)。手前の語にパスが貼り付いて見える `proj<ZWSP>/Users/u/proj` は、`proj/Users/u/proj` と打ったのと
  同じなので畳まない。
- **指紋の取りこぼし**: コードで扱わず、3節の「指紋の取りこぼし」に書いた。
- **見送りの理由の見える文字**: 結合文字(`\p{M}`)と点字の空白 U+2800 だけの理由も 400(R4-7 の拡張)。
- **R4-2 の言い方**: 理由は「トンネル越しに値が戻る」ではなく「書き手とログへ値を戻さない」(上の R4-2)。

**この PR ではやらないこと**

- 保存期間・ディスク総量の上限(m-4)。この PR では下書きと画像が増え続けた。bdboard-00qh で対応した(4節「保持期限と合計容量」)。
- 手元の `envInfo` を、マージのたびに最新へ更新すること(m-6)。4y8q.3 で扱う。**bdboard-4y8q.3.1 で入れた**: `pending` の下書きへ
  まとめるとき、報告に `envInfo` があれば `envInfo` と `harnessVersionAtOccurrence` を最後の発生のものに替える(`addOccurrence`)。
  `envInfo` の無い報告では前の値を残す。`envInfo` があってハーネスの版だけ無いとき(`{}` など)は、`envInfo` は最後の報告のものに
  替え、`harnessVersionAtOccurrence` は前の値を残す(版を書かない報告で、知っている版を消さない。レビュー m-4)。**最初の発生の版は残さない**: 画面の「版の比較」は最新の pack の版と並べて「最新の版では直っているかもしれない」を
  出すためのもので、比べる相手は最後に起きたときの版(最初の版と比べると、もう直った版での発生を古い版の発生と見誤る)。最初の版が
  要るなら欄を足す(`firstEnvInfo` など)。見送り済み・投稿済み(回数だけ足す)と「大量発生」の下書きの版は替えない。

**受け取りの置き場所(bdboard-4y8q.6.1、設計からのずれは無い)**

`src/application/issue-report/issue-draft-service.ts` が ESLint の行数(空行・コメントを除く 200 行)に迫ったので、受け取り
(統合・新規作成・「大量発生」への丸め込み)の本体を `src/application/issue-report/issue-draft-receive.ts` の
`receiveDraftLocked(ctx, input)` へ移した。**移しただけで挙動は変わらない**。サービスは `exclusive(() => receiveDraftLocked(ctx, input))`
を呼ぶだけで、排他(mutex)・索引・掃除・容量の判定はサービスの中に残り、`DraftReceiveContext`(storage の `get`・`indexCache.get`・
`pruneIfDue`・`saveWithinCap`・`now`・`newId`)として渡す。`ReceiveDraftResult` の型は同じファイルへ移し、サービスから再エクスポートする
(外から見える名前は変わらない)。

### 本体エラーの間引き(bdboard-4y8q.6.2、domain の純粋関数 3 つ)

画面の自動更新(`refreshProjects`)の失敗を種類 C の下書きにするとき、同じエラーが更新のたびに出続けても下書きの元になる報告は
1 時間に 1 回に絞る。配線(下書きサービスの呼び出し・HTTP)は 4y8q.6.3 で、ここでは IO を持たない部品だけを作った。

| ファイル | 公開するもの | 役割 |
|---|---|---|
| `src/domain/self-error-throttle.ts` | `createSelfErrorThrottle({intervalMs?, maxKeys?})` → `shouldReport(key, now)` / `forget(key)` / `size()` | キーごとの最後の報告時刻。既定 1 時間に 1 回、覚えるのは 500 キー(LRU) |
| `src/domain/self-error-mask.ts` | `maskSelfErrorText(text, projects)` / `createSelfErrorMasker(projects)` | 根・別名のパス → `<project-root>`、接頭辞で始まるチケット ID → `<ticket-id>`、名前 → `<project>` |
| `src/domain/refresh-error-tracker.ts` | `createRefreshErrorTracker({throttle?})` → `observe(result, projects, now)` → `SelfErrorReport[]` | リフレッシュ結果から「いま報告するもの」を選ぶ |

**追跡の規則**: キーは `(kind, 伏せた detail)` で、プロジェクトをまたいで共有する(別のプロジェクトの同じエラーは伏せたあと同じ文字列になり、
1 時間に 1 回に数える)。初めて現れたら報告し、続いている間は throttle に従う。`lock-contention` と `timeout` は同じプロジェクトで
3 回続けて(`errors` に出て)から初めて報告し、閾値に届く前は throttle に聞かない(聞くと 3 回目が間引かれる)。
`refreshed` に入っているプロジェクトに、前に続いていたキーが今回の `errors` に無ければ解消として状態を消す(次に現れたら「初めて」)。
`refreshed` に入っていないプロジェクトの状態は、`errors` に出たキーの更新以外では変えない(一部だけのリフレッシュで消えない)。
`removed` のプロジェクトは状態を捨てる。throttle のキーを忘れるのは、どのプロジェクトにもそのキーが無くなったときだけ。

**設計からずれた点・決めたこと**

| # | 項目 | 実装 |
|---|---|---|
| 1 | `observe` の引数 | 仕様の入力(結果とプロジェクト一覧)に **`now: Date`** を足した。throttle が時刻を要るため。時計は domain に持たない |
| 2 | 名前・チケット ID の語の境界 | 5 節の固有名詞(前後が文字・数字でない)と違い、**前後が ASCII の英数字でないこと**だけを見る。日本語の文は語を空白で区切らないので、`サーバーexample-projectを開けない` の名前も伏せるため。`_` と `-` は境界として扱う(`beads_<名前>`・`<名前>-server` も伏せる。漏らさない側に倒す)。`\b` は使わない。パスだけは別のフォルダ名の一部かを見るので、Unicode の文字・数字と `_`・`-` を「続き」とみなす |
| 3 | 3 文字未満の名前 | コードポイント数で数え(前後の空白は落としてから)、置き換えない。5 節の 4 コードポイントとは別の値(こちらは検出をせず、公開本文の最後の網は 4y8q.4 が別にかける) |
| 4 | チケット ID の形 | `<接頭辞>-<英数字(.英数字)*>` を ID 全体として伏せる。接頭辞が `bd` のように短いと、`bd-cli-…` のようなファイル名も `<ticket-id>` になる(過剰に伏せる側) |
| 5 | 置き換えの順 | 元の文字列の上で一致の範囲を集め、パス > チケット ID > 名前の順で重ならないものだけを 1 回で印に替える。印の中身を探し直さない |
| 6 | 未知のプロジェクトのエラー | `errors[].projectId` が一覧に無いものは**報告せず、状態にも入れない**(name と path が分からず、伏せる名前も分からないため。fail-closed) |
| 7 | 状態の上限 | 1 プロジェクトが覚えるキーは 20(超えたら最も古いものを捨て、throttle からも外す)。キーに入れる伏せた文は 1024 コード単位を超えたら先頭・長さ・末尾に畳む(中だけが違う長い文は同じキーになる)。`errorText` 自体は畳まない |
| 8 | 時計が戻ったとき | 最後の報告時刻を now に置き直して false を返す(戻り幅の分だけ黙り続けない。再開は最大 1 回分の間隔の後)。無効な Date は false で何も変えない |

**この PR ではやらないこと**: `refreshProjects` との配線、下書きサービスの呼び出し、環境変数 `BDBOARD_SELF_ERROR_DRAFTS` による停止(U6)、
`LocalOnlyKeys` を全プロジェクトの名前・根・接頭辞に広げること(U13、4y8q.4)。後続は 4y8q.6.3。

## 5. 公開本文の組み立てと置き換え(項目 e、bdboard-4y8q.2)

`domain` 層の純粋関数(`src/domain/issue-public-*.ts`、入口は `issue-public-build.ts` の `buildPublicIssueBody`)。
入力を**公開してよい固定欄だけの型 `PublicBuildInput`**と、**公開してはいけない手元だけの鍵 `LocalOnlyKeys`**
の別々の引数に分ける。`PublicBuildInput` に `localOnly`/`occurredProjects`/チケットの ID や本文/注入先のコードなどの
欄は無く、`IssueDraft` や `LocalOnlyContext` を丸ごと渡す形(変数に入れた値でも)は `NoExtraKeys` で型エラーにする
(それらの**まるごとの混入**を型で塞ぐ。4y8q.2 の要求。1節末尾の注記も参照)。実行時にも、型の外から来た余分なキーは
読まない(欄は名前で読み、欄の列挙やスプレッドはしない)。自由記述(`symptom`/`cause`/`prevention`/`errorText`/`agentNote`)は
意図して入力に含まれており、これらに残りうる固有名詞・秘密情報を実際に取り除くのは以下の置き換え規則の役目であって、
型そのものが担保するわけではない。

```ts
// issue-public-types.ts
interface PublicBuildInput {
  readonly kind: DraftKind;
  readonly catalogSlug?: string;          // A のみ
  readonly source?: string;               // B/C の出どころ(hook・スクリプトの名前)
  readonly symptom?: string;
  readonly cause?: string;
  readonly prevention?: string;
  readonly errorText?: string;            // 切り詰め前の生ログ全文(保存側の errorTextRaw。4節)。置換はこの全文に対して行う
  readonly agentNote?: string;            // 「新しく報告」の説明文もここを通す(要求どおり)
  readonly versions: DraftEnvInfo;
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
}

type ProperNounCategory = 'project' | 'user' | 'host' | 'branch';
interface LocalProperNoun { readonly category: ProperNounCategory; readonly value: string; }

// 手元だけの鍵。「探す文字列」としてだけ使い、出力の材料にしない。
interface LocalOnlyKeys {
  readonly projectRoots: readonly string[];       // プロジェクトの根の絶対パス(/ \ \\ のどれでもよい)
  readonly properNouns: readonly LocalProperNoun[]; // 長さの規則は下の「固有名詞の長さの規則」
}

// start/end は最終の title / body への UTF-16 コード単位のオフセット(半開区間)。範囲は出力に書いた印の
// 文字列(`<redacted-token>`・`~/` など)を覆う。元の文字列の位置ではない。
interface RedactionMark { readonly field: 'title' | 'body'; readonly kind: RedactionKind; readonly start: number; readonly end: number; }
// 位置は RedactionMark と同じ。matched は最終文字列の切り出し。
// kind は RedactionKind のほかに 'key-overflow' (手元の鍵を上限で落とした。位置は無く start = end = 0、matched は空)。
type SuspectedLeakKind = RedactionKind | 'key-overflow';
interface SuspectedLeak { readonly field: 'title' | 'body'; readonly kind: SuspectedLeakKind; readonly start: number; readonly end: number; readonly matched: string; }

interface PublicBuildResult {
  readonly title: string;
  readonly body: string;
  readonly redactions: readonly RedactionMark[];   // 画面で印を付けるための位置
  readonly suspectedLeaks: readonly SuspectedLeak[]; // 置き換え漏れの疑い
  readonly keysTruncated: boolean;                 // 鍵 (固有名詞・根) の一部を探していない (下の「上限」)
}

type NoExtraKeys<Shape, Actual extends Shape> = Actual & Record<Exclude<keyof Actual, keyof Shape>, never>;
function buildPublicIssueBody<I extends PublicBuildInput>(input: NoExtraKeys<PublicBuildInput, I>, keys: LocalOnlyKeys): PublicBuildResult;
```

内部は小さなモジュールに分ける(各ファイルに単体テスト): `issue-public-text`(孤立サロゲートの除去・整形・
コードポイントでの切り出し)、`-secrets`(トークンの形の表とメール)、`-pem`(秘密鍵ブロック)、`-home`(ホームのパス)、
`-keys` と `-key-variants`(手元の鍵を探索用に準備、NFC/NFD・パーセント表記の変種)、`-spans`(置き換えと最後の網が共有する
一致の集め方と統合)、`-redact`(統合した一致の置換と省略)、`-markdown`(コードスパン/ブロック)、`-leaks`(最後の網)、
`-build`(合成)。ホームのパスは既存の `issue-draft-identifier.ts` の本体の正規表現(`HOME_PATH_BODY_SOURCE`)を共有するが、
開始位置の条件だけは `-home` が持つ別のもの(指紋の `foldHomePaths` は変えない。下の規則 2)。

### Markdown の無害化(動的な文字列はコードの中にだけ出す)

本文のうち**固定の雛形以外の文字列は、必ずインラインのコードスパン(1行の値)かフェンス付きコードブロック(複数行の値)
の中にだけ出す**。リンク・`@メンション`・`#123`・`owner/repo#1`・`<img>`・HTML コメント・見出し・引用が有効な書式として
働く道がなくなる(#859 のレビュー指摘)。区切りは中身の最長のバッククォートの連より1長くし(フェンスは3以上)、中身が
バッククォートで始まる/終わるときはスペースを1つずつ足す。コードブロックの情報文字列は固定の `text`、閉じるフェンスの前に
改行を1つ置く。孤立サロゲート(対になっていない上位/下位)は、どの欄でも整形の最初に取り除く(JSON や UTF-8 にしたとき壊れた文字になる)。
1行の値(題名・名前・版・時刻)は改行・タブ・行区切りを空白に畳んで長さの上限を付け、複数行の値(症状など)は8000
コードポイント、エラー全文は先頭1000+末尾1000コードポイントで省略する(省略した件数は固定の文言+数字)。
**不可視文字は空白に畳まず取り除く**: 制御文字・書式文字(Cc・Cf)に加え、`Default_Ignorable_Code_Point`(結合文字の U+034F・
異体字選択子・モンゴル語の自由異体字選択子など)も、どの欄からも、また手元の鍵の側からも取り除いてから比べる
(残すと `exam<U+034F>ple` が名前と同じに見えるのに一致せず、置き換えをすり抜けるため)。
**端末の色・カーソル制御(ANSI エスケープ)は、制御文字の除去の前に、まとまりごと取り除く**: CSI(`ESC [ … 終端文字`)、
OSC(`ESC ] … BEL` または `ESC ] … ESC \`)、8 ビットの CSI(U+009B)に加え、ログや JSON に文字列として残った
`\u001b[`・`\x1b[`・`\033[`・`\e[` の 4 つの書き方も同じ CSI として扱う(ESC だけを先に除くと `[36m` が残って
`[36m/Users/…` の直前が英数字に見え、ホームのパスの開始条件に合わなくなるため)。
CSI の中間バイトは空白から `.` まで(`/` を含めない)、終端は `@`〜`~` から `\` を除いたものとし、終端の直後が `:` と区切りのとき
(ドライブ文字の `ESC[C:\Users\…`)は CSI と読まない。**途中で切れた CSI の直後にパスが続く形**(`ESC[/Users/jdoe/x`・
`ESC[ /home/jdoe/x`・U+009B + `/Users/…`・`\e[ /Users/…`・`ESC[C:\Users\…`)は、パスの頭を食わずにそのまま残し(ESC は制御文字として
消えるだけ)、ホームのパスとして置き換える。**2 文字のエスケープ**(`tput sgr0` の `ESC(B`、`ESC)0`、`ESC7`・`ESC8`・`ESC=`・`ESC>`)も
取り除くが、2 文字目はこの限られた文字だけで、パスの頭の文字(英字・`/`・`~`)は食わない。`\e[` を含む書き方は Windows のパス
(`C:\e[…`)も同じ形に見えるので、そのまま CSI として取り除いてしまう過剰な除去がありうる(公開本文では過剰な除去を選ぶ)。
ESC が先に失われて `[36m` だけが残ったものは、取り除かず(普通の角括弧と区別できないため)最後の網の報告に任せる。
本物のカーソル前進 `ESC[C` の直後が `:\` で始まる(ドライブ文字と区別できない)形だけは、カーソル移動としては取り除かず、
パスとして読む。
版や時刻(1行の値)が整形後に空のときは、空のコードスパンではなく固定の `(なし)` を出す(動的な値が無いことを雛形の側で示す)。

### 固有名詞の長さの規則

- **4 コードポイント以上**: 大小文字を区別しない部分一致で、**置き換えも検出もする**。
- **2〜3 コードポイント**: **置き換えない**(一般語を壊すと報告が読めなくなる)。単語として現れたとき(前後が文字・数字でない)
  だけ**検出**して人に知らせる。
- **1 文字・空・512 コードポイント超・ストップリスト**(`main` `master` `develop` `trunk` `head` `root` `localhost`、大小文字を
  区別しない)は無視する(512 超は上限の扱いで、下の「上限」の `key-overflow` になる)。
- **探す書き方の変種**: NFC と NFD(macOS のファイル名は分解形のことがある)の両方に、それぞれ生・
  `encodeURIComponent`・`encodeURI` のパーセント表記(`%E3%81…`。16 進の大小文字は区別しない)を足して探す。
  URL やログに入った形でも一致する。
- **同じ名前の重複**は、カテゴリと NFC・小文字化した値が同じものを 1 件にまとめる(重複で上限を食いつぶさせない)。
- プロジェクトの根のパスは、区切りの書き方の変種(`/`・`\`・JSON の `\\`)と上の変種を並べて探す。直後が
  文字・数字・`_`・`-` なら別の名前(`example-project2`)として一致させない。末尾の区切りは手で(正規表現の `[\\/]+$` を使わずに)
  落とす。さらに根の**最後の要素(basename)が 4 コードポイント以上なら、`project` の固有名詞としても登録する**
  (`/work/example-project` の根から `example-project` という単独の言及も拾う)。**4 コードポイント未満の basename
  (`/work/app` の `app`)と、一般的なフォルダ名(`test`・`src`・`app`・`web`・`server`・`client`・`lib`・`docs`。大小文字を区別しない)は
  名前としては登録しない**(登録すると、どの本文の `server` も `<project>` になり報告が読めなくなる)。根のパスそのものは
  これらでも探すので、`/work/server/src/x` のようなパスの形の言及は置き換わる。1024 コードポイントを超える根は探さない。

**上限と fail-closed(`key-overflow`)**: 固有名詞は最大 200 件(`MAX_NOUNS`)、根は最大 200 件(`MAX_ROOTS`)だけ探す。
超えるときは**重要な順に残す**: (1) `project`/`user`/`host` で 4 コードポイント以上、(2) `branch` で 4 コードポイント以上、
(3) 2〜3 コードポイントの短い名前(同順位は入力順)。3 の短い名前が最初に落ちる(置き換えず検出だけの対象なので、
落としても本文は壊れない)。1 件でも落とした(件数超過・長さ超過)ときは `keysTruncated: true` とし、
`suspectedLeaks` の先頭に位置の無い `key-overflow`(`field: 'body'`、`start = end = 0`、`matched` は空)を足す。
「探していない鍵がある」ことを黙って通さず、人の確認(投稿の前に毎回見る)に回すための印で、上限を引き上げる理由にはならない。

### 置き換え規則(自動置換)

**処理の順序(動的な文字列1つごと)**: (0) 孤立サロゲートを除き整形 → (1) 置き換え(最大 2 回、下記) → (2) 省略(コードポイント単位) →
(3) コードスパン/ブロックで包んで組み立て(印の位置は組み立て時にずらす) → (4) 最終の題名・本文に最後の網をかける。
**エラー全文(`errorText`)や自由記述(8000 コードポイント)は、置き換えをすべて適用してから省略する(4節参照)。
先に切るとトークンや名前が境界で分断され、断片が残る。** 省略の切れ目が印(`<redacted-token>` など)の内側に落ちるときは
印の境界へ動かすので、印が半分に割れず、断片も残らない(省略側に入った印は消える)。**置き換えなかったが最後の網が報告する
候補(緩い版の一致。英数字に貼り付いた `sk-…`・`/Users/<名前>` など)にも同じ動かし方をかける**: 省略するときだけ、
置き換え済みの文字列に、最後の網のうち**報告だけの形**(緩い版のトークン・開始位置の条件なしのホームのパス・メール・鍵ブロックの
単独の印・2〜3 コードポイントの固有名詞。`findReportOnlySpans`)をもう一度かけ、その一致の範囲を印と同じ「切れ目を落とさない範囲」に足す。
プロジェクトの根と 4 コードポイント以上の固有名詞は探し直さない: 置き換えですでに印の中にあり、探し直すと鍵の側の O(n·m)
(下記)をもう一度払うため(その代わり、3 本目の連鎖で置き換えられずに残った名前は切れ目で割れて断片が残りうる。
下の「2 回目の置き換え」の限界の延長で、直さない)。頭側の切れ目は範囲の先頭へ、末尾側の切れ目は範囲の末尾へ動かすので、報告されるはずだった候補が切れ目で
半分になって報告もされない断片(`/Users/jd` のような先頭だけ)として残ることはない(候補は省略側に入って消えるか、全体のまま
残って報告される)。

置き換えは**すべての探索を同じ(整形後の)文字列にかけて一致の範囲を集め、重なるものは和集合に統合してから、左から
1 回の走査で印に替える**。先の規則の印の中に後の規則が一致することはない。統合した範囲の種別は、**秘密が勝つ**次の
優先順位で決める: key-block > token > project-path > home-path > project > user > host > branch > email > fragment
(fragment は下の「欄の端の断片」)。接しているだけの
一致は別のまま。たとえば鍵の文字列の一部が名前と一致していても、全体は `<redacted-token>` になる(`<user>` とは書かない)。

**2 回目の置き換え**: 1 回目の印に替えた結果の文字列にもう一度すべての探索をかけ、1 回目の印の内側に完全に収まる一致は捨て、
残りを新しい一致として統合して置き換える(1 回目で何も見つからなければ 2 回目は省く)。名前を消したことで、離れていた
2 つの断片が隣り合って新しい一致(たとえば英数字の直後に貼り付いていて 1 回目では開始条件を満たさなかった `sk-…` や、
`/Users/<名前>` の形)ができる経路を塞ぐためで、**2 回で打ち切る**(置き換えの繰り返しで本文が際限なく変わらないように)。
印の位置は 2 回目の結果の文字列に対する正確な位置で、単体テストが印の範囲の文字列を検査する。
**限界: 3 本以上の連鎖**(名前 + 名前 + 英数字で終わる `sk-` 形の鍵 + `/Users/…` のように、3 回目で初めて一致するもの)は最後の 1 本が
置き換わらずに残る。残ったものは最後の網が報告する(検出はするが置き換えない)。
2 回目は全体を探す。文字列探索で十分速いので窓には絞らない(bdboard-uudb)。

1. `projectRoots` の絶対パス(区切りの変種と NFC/NFD を含む)→ そのパス丸ごと `<project>`。
   (ホームの下にあるプロジェクトの根は、2より優先してパスごと `<project>` になる。統合の優先順位で、
   `~/path/to/<project名>` のような形でプロジェクト名だけが残らない。)
2. ホームディレクトリの絶対パス(`/Users/<名前>`・`/home/<名前>`・`C:\Users\<名前>`・`/mnt/c/Users/<名前>` など。
   パス本体の規則は `foldHomePaths` と同じ `HOME_PATH_BODY_SOURCE`)→ `~/`。**開始位置の条件は `-home` の緩い版**
   (`foldHomePaths` は変えない): 直前が空白・引用符・括弧・CJK の文章・句読点・`=`・`:` などのほぼ何でもよく、JSON に
   埋め込まれた `\n`・`\t`・`\r` の直後、`%XX` の直後、`@fs`(Vite の `/@fs/Users/…`)と `file`(`file:///Users/…`)の直後も許す。
   一文字のフラグ(`-I/Users/…`・`-L/home/…`・`-F`・`-B` のように、直前が `-` + 英字 1 文字で、その前が行頭・空白・引用符・`,`)の直後も許す。
   **パーセント表記のパス**(`%2F` または `%5C` を区切りとし、`Users` は大小文字を区別せず、`home` は小文字だけ)も拾う。
   名前は `%XX` のバイト列(日本語などの `encodeURIComponent` 形、`%20` の空白)を含められ、`%2F`・`%5C`・`%` に続く 16 進でない
   並び・空白・引用符・`&`・`<>`・生の `/` と `\` で終わる(`C%3A%5CUsers%5C<名前>` の `%5CUsers%5C<名前>` の部分を拾う)。
   **置き換えない場合と、そのときの扱い(意図した取りこぼし)**: パスが **ASCII の英数字の直後**から始まるときは、別の語の一部
   (URL の `/api/users/42`、相対パスの `src/users/x.ts` など)とみなして**置き換えない**(上の `\n`・`\t`・`\r`・`%XX`・`@fs`・`file`・
   一文字のフラグの直後は英数字でも置き換える)。ただし置き換えないだけで、最後の網の**緩い検出**(開始位置の条件が無く、
   `/Users/<名前>`・`/home/<名前>`・`X:\Users\<名前>` の形だけを見る)が**報告はする**ので、黙って通ることはない
   (`12:00/Users/jdoe` や `abcC:\Users\jdoe` のように数字・英字に貼り付いた形)。緩い検出は大小文字を区別するので、
   英数字に貼り付いた**小文字**の `users/…`(`api/users/42` など)は報告しない(通常の URL の経路が大量に引っかかるため)。
   逆に英数字に貼り付いた `/home/<名前>` の形の URL のルート(`https://example.com/home/feed`)は過剰に報告する。
   この規則の裏返しとして、語尾が `file` で終わる `profile/home/x` の `/home/x` が置き換わるような過剰な除去は受け入れている
   (公開本文では過剰な除去を選ぶ)。
   ホームの別の配置(`/export/home/<名前>`・`C:\Documents and Settings\<名前>`・`~名前/`)は置き換えない(`/export/home/<名前>` は
   最後の網が `/home/<名前>` の形として報告する)。アポストロフィを含む名前
   (`C:\Users\O'Brien` は `O` で切れて `Brien` が残る)は拾えない(下の「カバーしないもの」)。小文字の `/home/…`・`/users/…`
   で始まるアプリのルートや相対パス(`./home/Component.tsx`・`../users/service`・`#/home/settings`・`href="/home/about"`・
   `GET /users/42`・`profile/home/x`)はホームのパスに見えるため置き換わりうる過剰な除去で、受け入れている。
3. `properNouns` の値(4 コードポイント以上のもの。大小文字区別なしの部分一致)→ カテゴリに応じて
   `<project>`/`<user>`/`<host>`/`<branch>`。1・2はパスの形をした言及を拾うためのもので、この3は
   プローズ中の言及を拾う。2〜3 コードポイントの値は置き換えず、最後の網で検出だけする。
4. 秘密鍵ブロック → `<redacted-key-block>`。開始と終了のマーカーを線形に走査して対にする(`[\s\S]*?` の正規表現は使わない。
   大小文字は区別しない)。対象の形:
   - PEM: `-----BEGIN … PRIVATE KEY-----`(`PRIVATE KEY BLOCK` も含む。EC・OPENSSH・ENCRYPTED・PGP など。ラベルは英大文字・数字・
     空白・ハイフンで 40 文字まで。ダッシュは 3〜5 個: ログの折り返しや整形で 1〜2 個落ちた形も拾う)から
     対応する `-----END …-----` まで丸ごと。
   - SSH2 形式: `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----` など(ダッシュ 3〜5 個、マーカーの内側の空白は 1 個まで任意)。
   - PuTTY 形式: `PuTTY-User-Key-File-<n>:` が現れたら、この形式には終端のマーカーが無いので**文字列の末尾まで**
     (後ろに END があればそこまで)。
   - **孤立した END** は、直前のブロックの終わり(無ければ文字列の先頭)から END まで消す(BEGIN だけが切り詰めで先に失われた場合)。
     **END の無い BEGIN** は文字列の末尾まで消す。どのマーカーも、置き換えのあとはいずれかの印の中に入る
     (「マーカーだけが残る」ことはなく、残ればそれは最後の網が報告する)。
5. トークンらしい文字列 → `<redacted-token>`。次の形を**自動置換**する(網羅的な一覧ではない。形を足すときは
   `issue-public-secrets.ts` の表に1行足し、長い入力で線形に動くことを確かめる):
   - GitHub: `gh[pousr]_[A-Za-z0-9]{20,}` / `github_pat_[A-Za-z0-9_]{20,}`
   - `sk-` 系(OpenAI の旧形式・`sk-proj-`・`sk-svcacct-`・Anthropic の `sk-ant-`): `sk-[A-Za-z0-9_-]{20,}`
   - Stripe: `[sr]k_live_[A-Za-z0-9]{16,}`
   - AWS アクセスキー ID: `(?:AKIA|ASIA)[0-9A-Z]{16}`
   - Slack: `xox[abeprs]-[A-Za-z0-9-]{10,}` / `xapp-[A-Za-z0-9-]{10,}`
   - Google API キー: `AIza[0-9A-Za-z_-]{35}` / Google の OAuth アクセストークン: `ya29\.[A-Za-z0-9_-]{20,}` / npm: `npm_[A-Za-z0-9]{36}`
   - JWT: `eyJ…` `.` `eyJ…` `.` 署名(各 8 文字以上)。開始位置を「連の先頭」に限るので、`eyJ` の繰り返しの 10 万文字でも線形に動く。
   - Bearer: `Bearer` + 空白/タブ/`%20`(1〜16)+ `[A-Za-z0-9._~+/-]{16,}=*`(大小文字区別なし)

   `sk-`・Stripe・JWT・Bearer には**語の途中を除く開始条件**がある: 直前が ASCII の英数字なら、別の語の一部
   (`risk-assessment-…`・`task-force-…`)とみなして置き換えない。ただし JSON に埋め込んだログの `\n`・`\t`・`\r`
   (バックスラッシュと n/t/r)の直後と、URL のパーセント表記(`%3D`・`%20` など `%XX`)の直後は、実際のエラー文に多いので
   開始を許す(JWT は直前の `_`・`-` も除く)。
   この条件から漏れた形(英数字が貼り付いた `sk-`・`Bearer`・`sk_live_…`、英数字・`_` に貼り付いた JWT、小文字の `akia…`/`asia…`)は、
   **置き換えず、最後の網が緩い版で報告する**(下の「置き換え漏れの検出」)。緩い版の JWT は、貼り付いた先頭の `eyJ…` を待たず
   2 つ目の部分 `.eyJ….署名` から報告する(先頭の `eyJ` を必須にすると `eyJ` の繰り返しで 2 乗になるため、`.` で始まる形にして線形に保つ)。
   「32文字以上の英数記号の塊」は誤検知(コミットハッシュ等)が多いため自動置換しない。
   AWS のシークレットキー(40文字)も形がなく置き換えない。
6. メールアドレス → `<email>`(ローカル部は文字・数字・`_.+-`、区切りは `@`・パーセント表記の `%40`・全角の `＠`。ドメインは
   ドットを 1 つ以上含み、最初のラベルより後ろに**英字で始まるラベルが 1 つ以上ある**もの。ローカル部の連の先頭だけを開始位置にして
   線形に探す。英字で始まるラベルを見つけたら、その**後ろの `.` 付きのラベル(数字だけでもよい)も全部ドメインとして取る**:
   `jdoe@example.com.1`・`.2024`・`.0.1` は全体で `<email>` になる(`<email>.1` のような断片も、素通りも残さない)。
   英字で始まるラベルが無いので、パッケージの版 `react@18.2.0`・`typescript@5.6.3`・`vitest@4.1.11`・`@types+node@22.1.0`・
   プレリリース `react@19.0.0-rc.1`(`0-rc` は数字で始まる)はメールとみなさず、そのまま残る(置き換えると報告が読めなくなる)。
   4 つ組の数字の IPv4 をホストにしたもの(`deploy@10.0.0.5`)は引き続きメールとして置き換える(直後が数字・英字・`-` のときは
   IPv4 とは読まない: `deploy@10.0.0.1234` を `<email>4` のように切らない)。`name@2x.png` のような名前は消えるが、公開本文では
   過剰な除去を選ぶ。ドットの無い `user@host` と、英字で始まるラベルの無い `jdoe@example.123` は消えない: 下の「カバーしないもの」)。

探索は 10 万文字の敵対的な入力(空白・改行・タブ・`eyJ`・`-----BEGIN ` などの繰り返し)でも線形に動くように書き、単体テストで
時間を確かめる。**手元の鍵(根と 4 コードポイント以上の名前)は、正規表現ではなく、大文字小文字をたたんだ文字列の `indexOf` で探す**
(`issue-public-casefold.ts`、bdboard-uudb)。以前は鍵の変種ごとに `/…/giu` のリテラルの正規表現を作っていた。V8 は `i` フラグの
正規表現を文字ごとの大文字小文字の閉包つきでコンパイルするので、長い鍵(CJK・濁点・`/` を混ぜた 1024 コードポイントの根 200 件 →
変種 2,800 本、1 本 6,000 文字前後)では 1 本 3〜6 ms かかり、コンパイル済みのコードはキャッシュから追い出されるので、欄ごと・
置き換えの回ごとにコンパイルし直していた。プロファイルでは時間のほぼ全部がこのコンパイルで(本文の走査そのものは 1 回数 ms)、
1 回の組み立てが 117〜233 秒かかった。今は正規表現エンジン自身に 1 文字ずつ同値類を尋ねて表を作り(大文字小文字で変わりうる
約 3,000 文字。1 プロセスで 1 回、約 0.2 秒)、本文と鍵を表の代表の文字にたたんでから探す。以前と同じ一致になる理由と、表を使えない
エンジンで以前の正規表現に戻る条件は `issue-public-casefold.ts` の冒頭にある(要旨: `u` フラグの `i` は 2 つの文字の単純な大文字小文字の
たたみが等しいとき一致とし、リテラルの各文字は 1 コードポイントにだけ一致する。表を作るときに、類が対称・推移的であること、類の中で
UTF-16 の長さが混ざらないこと、表の外の文字が表のどの文字とも同じとみなされないことを確かめる)。単体テストが、特殊な類(Kelvin・
long s・ß/ẞ・İ/ı・σ/ς・θ/ϑ/ϴ・U+0345・Cherokee・Deseret など)を混ぜた乱択と、大文字小文字で変わりうる全文字を鍵にした場合で、以前の
正規表現と同じ一致を返すことを確かめる。2〜3 コードポイントの名前(報告だけ)は前後の条件つきの正規表現のまま。
探索は、本文の長さ n と鍵の長さの合計 m について、V8 の文字列探索(`indexOf`)の時間になる(重なる出現を読み進める分は下の KMP で、
鍵 1 つあたり O(n + 鍵の長さ) を足すだけ)。上限(最大 200 件 × 512/1024 コードポイント、端の検査の鍵の 200 万コードポイント)はそのまま。

**表が使えるかの確かめとログの code(bdboard-uudb、bdboard-qoxj)**: 表を作るときの検査に落ちるエンジンは表を使わず、以前と同じ `/…/giu` で探す
(結果は同じだが、大きい鍵では組み立てが数分かかる)。この退避が黙って起きないよう、サーバーは起動の直後に 1 回だけ、表が使えるかを確かめる
(`bootstrap/wire-issue-reports.ts` の `setImmediate`。表の組み立てでイベントループが 0.1〜0.3 秒止まる。以後の組み立ては作り済みの表を使う)。
ログには code だけを出す(起動の掃除の警告 `issue draft prune at start failed (<code>)` と同じ形。`error.message` もパスも出さない):

| code | ログ | いつ |
|---|---|---|
| `case-table-fallback` | `issue public body: case table unavailable, using the slow regex search (case-table-fallback)` | 表を作るときの検査に落ちた(表は作らず、以前の正規表現で探す)。1 回だけ |
| `case-table-check-failed` | `issue public body: case table check failed (case-table-check-failed, <error.code。無ければ unknown>)` | 確かめる処理自体が投げた。サーバーは落とさない。表は作れていないので、以後の組み立て・再走査のたびに表の作り直しを試み、投げている間は結果を返さない(黙って退避しない。投げたものは組み立て・再走査の側の失敗として表に出る) |

**たたんだ本文の覚えは 1 回の走査の間だけ**(bdboard-uudb、bdboard-qoxj): 根・LONG の名前・最後の網は同じ本文を続けて探すので、直前にたたんだ本文を 1 つだけ覚えて
たたむのを 1 回にする。純粋な関数の結果を覚えるだけなので一致は変わらず、公開にも出ない。ただし本文は手元のパスやトークンを含みうるので、覚えは
`withFoldedTextMemo`(`issue-public-casefold.ts`)の中だけで持ち、返っても投げても終わりに捨てる。入口は 2 つで、組み立て(`buildPublicIssueBody`)と、編集した欄の
置き換え漏れの再走査(`scanEditedText`。`withRescannedLeaks`・`applyDraftEdit` もここを通る)。呼び出しごとに「忘れる」を足す形にしなかったのは、return の直前に
置くと投げたときに残り、入口を足すたびに呼び忘れるため。単体テスト(`issue-public-fold-memo.test.ts`)が、どの入口でも終わりに覚えが残らないこと(投げた場合を含む)を確かめる。

**自分と重なる鍵(bdboard-0hj9)**: 鍵が自分と重なる(`-ba1-ba1-ba` のように先頭と末尾が同じ部分を持つ周期的な綴り)とき、以前の探索は
一致の終わりから次を探したので、欄の途中で 2 つの出現が重なって現れると 2 つ目を拾わず、その後ろが残った
(名前 `-ba1-ba1-ba`、本文 `log: -ba1-ba1-ba1-ba done` → `log: <project>1-ba done`)。1 行の欄(題名の名前・「対象」・版・時刻)は
端の検査が走らないので、欄の末尾でも残り、`suspectedLeaks` にも出なかった(`hook -ba1-ba1-ba1-ba` → `hook <project>1-ba`)。
今は、`indexOf` で最初の出現を見つけたら、そこから **KMP**(鍵の失敗関数。その鍵に一致があったときだけ作って覚える)で本文を読み進め、
重なる出現もすべて探して、**厳密に重なる出現は 1 つの範囲に併合する**(接しているだけの出現は別の範囲のまま)。状態が 0 に戻ったら
`indexOf` に戻るので、一致の少ない入力の速さは変わらず、周期的でない鍵では出力も変わらない。根は出現ごとに直後の文字の条件を見て、外れた出現は
範囲に入れずに KMP を続ける(外れた出現と重なる別の出現を見落とさない。以前は外れるたびに 1 つ右から探し直していた)。条件の検査は位置ごとに
覚えて鍵の間で共有する(周期的な根は出現が O(n) 件になる)。表を使えないエンジンの退避は、先読みの捕獲 `(?=(鍵)(?![…]))` で出現をすべて集めて同じ併合をかける。
2〜3 コードポイントの名前(SHORT。報告だけ)は変えない: 置き換えないので「重なる出現の後ろが残る」問題は無く、1 件でも見つかれば報告する。

時間(2026-10-05、同じマシンで `tsx` から `buildPublicIssueBody` を直接呼んだ値。括弧は負荷平均。鍵は上限いっぱいの敵対的なもの):

| 入力 | 変更前 (origin/main) | 変更後 |
|---|---|---|
| CJK・濁点・`/` の 1024 コードポイントの根 200 件、エラー文 6.4 万文字(1 欄) | 233 秒(8.7)/ 末尾が根の断片のとき 151 秒(9.4) | 1.1〜1.6 秒(4.5) |
| 同じ鍵で 5 欄(エラー文 6.4 万文字 + 自由記述 8,000 文字 × 4。末尾が根の断片) | 272 秒(4.3) | 1.3〜1.5 秒(4.5) |
| 先頭が同じで末尾だけが違う約 500 文字の名前 200 件と約 1000 文字の根 200 件、本文は `a` の 6.4 万文字(1 欄 / 5 欄) | 9.4 秒 / 12.3 秒(4.0) | 0.19 秒 / 0.23 秒(4.0) |
| 同じ鍵で欄の末尾が名前の断片(1 欄 / 5 欄) | 8.5 秒 / 13.0 秒(4.1) | 0.22 秒 / 0.28 秒(4.1) |
| 先頭だけが違う鍵(Boyer-Moore の不得手な形。1 欄 / 5 欄) | 3.1 秒 / 3.2 秒(4.8) | 0.21 秒 / 0.25 秒(4.7) |

変更後の残りの大半は `prepareKeys`(端の検査の鍵を組み立てる `fragmentKeyCollector` の 1 回約 0.7 秒と、変種の生成)と、表の最初の
1 回の組み立て。現実的な鍵(名前は短く数十件、6.4 万文字のログ)では組み立て全体で数十 ms。数字は目安で、負荷が重いと同じ入力が
2 倍以上かかる(並行する検証の負荷の下では秒数を保証しない。単体テストは秒数を固定しない)。
**組み立て全体の時間の上限は置かない**: 上の値なら鍵の上限(件数・長さ・端の鍵の合計。超えたら `truncated` と `key-overflow`)の内側で
最悪が数秒に収まり、時間で打ち切ると同じ入力で結果が変わる(テストで確かめられない)。例外だった周期的な鍵: 根 200 件 `a` × (1024 − i)・
本文 `a` × 64,000 は 11.5〜11.9 秒(origin/main は 16.6 秒。負荷平均 5〜7、bdboard-uudb のレビュー)だった。根は直後の文字で外れるたびに
1 つ右から探し直すので O(本文 × 鍵 / 周期) になっていた。bdboard-0hj9 の KMP で線形になり、同じ根 200 件・本文 `a` × 64,000 は
0.27 秒(2026-10-05、1 回の測定、負荷平均は未記録。`/` 付きの根 `/a` × (1023 − i) では 0.59 秒で、こちらは鍵の上限で `key-overflow` が立つ)、先頭が同じ `a` × (512 − i) の名前 200 件も 0.60 秒。
周期的な鍵は出現が O(本文) 件になるので、一致の少ない鍵より 1 つあたりの時間は長い(JS の読み進めの分)。実在のパスは周期が長さと同じくらいで、
一致が少ないので `indexOf` の速さのまま。
省略するときだけ走らせる最後の網の探索(上の「処理の順序」)は、鍵(根と LONG の名前)を使わない**報告だけの形に限る**:
全部の探索をもう一度かけると、鍵の側の探索をもう一度払う(4y8q.13 の時点の正規表現の探索では、同じ最悪の入力の 6.4 万文字に
全探索をかけた追加分が約 5 秒、報告だけの形に限ると約 2 ms。鍵の探索を `indexOf` にした後は差が小さいが、規則は変えない)。
鍵の探索をさらに線形に近づける(Aho-Corasick など)のは、上の時間で足りなくなったとき(4y8q.4 の配線で同期の経路に置き、
数秒が応答時間として問題になるとき)に決める。
根の末尾の区切りを落とす `/[\\/]+$/` は区切りが長く続くと 2 乗になるため使わない(手で落とす)。

### 欄の端の断片(bdboard-4y8q.13)

保存の上限(4節: `errorTextRaw` の 64Ki、自由記述の 8000、`draft.json` の 200KB の削り)と、末尾だけを取る送り手(hook の
tail-capture。4y8q.12)は、欄を途中で切る。公開本文はエラー文の先頭と末尾の 1000 コードポイントを見せるので、その切れ目が
ちょうど公開される端になる。名前・根・トークンの途中で切れると、完全な形を探す置き換え(上の規則 1〜6)にも最後の網にも
一致せず、`/work/example-proj`・`owner example-us`・`ghp_` + 15 文字・`sk-proj-` + 10 文字・頭の欠けた `ample-project/src/a.ts` が
置き換えも報告もされずに残っていた(4y8q.2 の再レビューの finding 3)。保存側の切り出しは UTF-16 のコード単位で切っていたので、
サロゲートの対も割れていた。

チケットの候補 (a)(b)(c) のうち、**(a) と (c) を組み合わせた**:

- **(a) 保存側で行の境目で切る**(`issue-draft-cut.ts`): 先頭を残す切り詰め(`capErrorTextRaw`・`capFreeText`・200KB の削り・
  表示用の `errorTextHead`)は、上限の内側の最後の改行の直後で切る(切れ目の直後が改行なら、そのまま)。末尾を残す切り詰め
  (表示用の `errorTextTail` と tail-capture)は、最初の不完全な行を捨てる。改行を探す距離は 4096 コード単位まで
  (`CUT_LINE_BACKOFF_MAX_CHARS`。スタックトレースやログの 1 行はふつうこれより短い。改行は公開本文の整形と同じ `\n` `\r` `\v` `\f`
  U+0085・U+2028・U+2029 で、CRLF の間では切らない)で、それより長い行(改行の無い 1 行の欄も)は
  行を丸ごと捨てずにコードポイントの境目で切る。どの切り詰めもサロゲートの対を割らない。長さは今までどおり UTF-16 のコード単位で
  数え、結果は上限以下なので、200KB の判定と保持期限・合計容量(4節。krvf の再調査の抑えも)の前提は変わらない(欄は短くなる
  向きにしか変わらない。200KB の削りは、戻した分だけ多めに削れる)。表示用の `errorTextHead`/`errorTextTail` だけは、戻る距離を
  上限 1000 の半分(500)までにする: 4096 まで戻すと、短い 1 行の後に長い行が続くとき(`x` + 改行 + 改行の無い 5000 文字)先頭が
  数文字しか残らなかった(bdboard-uudb の NIT-10)。半分より遠ければコードポイントの境目で切るので、どちらも上限の半分以上を残す
  (手元の表示専用。公開本文はこの切り出しではなく全文から作り、端の断片は (c) が拾う)。
- **(c) 公開本文の側で欄の端を調べる**(`issue-public-fragments.ts`。(a) が行の途中で切るしかなかったときの受け皿): 置き換えの
  探索(1 回目と 2 回目の両方)に、欄の端だけを見る探索を足す。見つけたものは種別 `fragment`・印 `<redacted-fragment>` に置き換える
  (報告ではなく置き換え。公開本文では過剰な除去を選ぶ)。
  - **末尾**(複数行の欄すべて): プロジェクトの根と 4 コードポイント以上の固有名詞(変種を含む)の、**4 コードポイント以上の
    前置部分(末尾では全体の一致も。下の「全体に一致するもの」)**で欄が終わるもの。トークンの接頭辞の後に本体が 1 文字以上あり、置き換えの長さの下限に届かずに欄が
    終わるもの(`TOKEN_PREFIX_AT_END`: `gh[pousr]_`・`github_pat_`・`sk-`・`[sr]k_live_`・`AKIA`/`ASIA`・`xox[abeprs]-`/`xapp-`・`AIza`・
    `ya29.`・`npm_`・`eyJ`(3 つの部分が揃わないもの)・`Bearer`。トークンの形の表と 1 対 1 で、単体テストが名前のそろいを確かめる)。
    ローカル部と `@`(`%40`・`＠`)の後が、空か英字で始まる途中までのドメインで終わるメール(`jdoe@exam`・`jdoe@`)と、`%40` の途中で
    切れたもの(`jdoe%4`・`jdoe%`。`progress 50%` を消さないよう、ローカル部に文字を 1 つ以上求める)。
  - **先頭**(**エラー文だけ**): 根と 4 コードポイント以上の固有名詞の、4 コードポイント以上で全体より短い後置部分で欄が始まるもの。
    末尾だけを取る送り手がいるのはエラー文で、人とエージェントが書く自由記述の先頭は切れない。自由記述の先頭も見ると、
    `user clicked save` が名前 `example-user` の後置部分 `user` として消える。1 行の値(名前・版・時刻)は入口で長さを拒否して保存で
    切らないので、どちらの端も見ない。
  - 全体に一致するもの(全体より短くない)は、**先頭の端では返さない**(通常の置き換えが拾い、根の直後の文字の条件 `example-project2` も
    そちらが持つ)。**末尾の端では返す**: 末尾には直後の文字が無いので、その条件と矛盾しない。bdboard-2ydj の時点では、本体の探索が左から
    重ならずに探していたので、自分と重なる名前(`-ba1-ba1-ba`)が末尾で重なって 2 回現れると、2 つ目を拾わず後ろの 4 コードポイントが残った
    (全体の一致も返して塞いだ。レビュー MAJOR-1)。今は本体が重なる出現も探す(上の「自分と重なる鍵」、bdboard-0hj9)ので、これは二重の網で、
    本体の一致と重なって統合で強い種別の印 1 つになり、ふつうの入力の出力は変わらない。重なった一致の統合では `fragment` が最も弱い(上の優先順位の最後): 欄の末尾にある完全なメールや JWT は、端の形にも
    一致するが `<email>`・`<redacted-token>` になる。
  - トークンの端の形の開始条件は、置き換えの形と同じ(`sk-`・Stripe・`Bearer` は直前が ASCII の英数字でない、JWT はそれに加えて
    `_` `-` でない。`gh[pousr]_`・`AKIA` などの接頭辞が固有な形は条件なし)。完全な形が置き換わる位置(`cfg.sk-…`・`MY_KEY_sk-…`・
    `x-sk-…`・`k_sk_live_…`・`session.eyJ…`)で切れたものは、断片も置き換える。ただし**報告だけの一致(最後の網の緩い形のうち、置き換えの形と
    同じ範囲ではないもの。英数字に貼り付いた `id1sk-…`・`id1eyJ….eyJ….署名`)に重なる断片は返さない**(置き換わる固定長の完全な形に
    重なる断片は返し、統合で 1 つにする。捨てると、`npm_` + 36 文字の直後に貼り付いて欄末で切れた `AIza…` の、後ろにはみ出した部分が
    残る): 報告されるはずのトークンの途中(2 つ目の `eyJ`・途中の `-sk-`)
    から断片を始めると、報告の一致を削って長さの下限を割らせ、残りが黙って残るため(最初の実装は、これを避けるために `_` `.` `-` の
    後ろの断片をすべて捨てていて、`cfg.sk-proj-…` が切れると素通りした。レビューの MINOR-3)。そのトークンは丸ごと残り、報告される。
    緩い形は断片の候補があるときだけ探す。
  - 大小文字は区別しない。欄の端の検査も本体の探索と同じ表(`issue-public-casefold.ts` の `foldCodePoint`)で各コードポイントをたたむ。
    表が使えないエンジンでは、エンジンに直接尋ねて、`/x/giu` で一致する文字の最小のコードポイントにたたむ(エンジンの関係が同値関係で、
    大文字小文字で変わりうる文字の中で閉じているとき、つまり表を作るときの検査 (1)(3) が成り立つときは、本体の `/…/giu` と同じ同値類。
    検査が崩れたエンジンでは食い違いうる。大文字小文字で変わらない文字は尋ねずそのまま)。以前は `toLowerCase` で、µ/μ・ς/σ・ϑ/θ・ſ/s・U+1FBE/ι が
    本体では同じ・端では別だった(bdboard-uudb のレビュー MAJOR-1 で変種ごとに鍵を足して塞ぎ、bdboard-2ydj でたたみ方そのものを揃えた)。
    `prepareKeys` が全部の変種を渡しても、たたんだ後で同じものは 1 つにまとまる。揃えたので、`i` フラグで同じとみなされる文字は端でも
    同じになる(`toLowerCase` では別だった類は、Node 22.14 で、上の 5 組を含めて 23。ほかに β/ϐ・ε/ϵ・κ/ϰ・π/ϖ・ρ/ϱ・φ/ϕ・ṡ/ẛ・キリル文字の ᲀ〜ᲈ・ﬅ/ﬆ など)。
    旧(`toLowerCase`)と新(表)を比べた使い捨ての差分ファズ(2026-10-05、bdboard-2ydj): (1) 全コードポイントで、旧が同じとみなす 2 文字は
    新でも同じ(違反 0 件)。(2) 乱択の鍵と本文(`µ`・`ς`・`ϑ`・`ſ`・U+1FBE・`İ` などを混ぜた文字表と、大文字小文字で変わりうる全文字の表の
    2 種、各 6 つの種)の 84,000 件(入力の座標での伏せる範囲 48,000 件と、2 回の置き換えを通した `buildPublicIssueBody` 36,000 件)で、
    旧が伏せた範囲を新が伏せ残した例は、この乱択では 0 件だった(新が多く伏せたのは、混ぜた文字表で 3〜4 割、全文字の表で 3〜4%。残る文字の列は
    新が旧の部分列)。表を使えないエンジンの退避(`engineFoldCodePoint`)も、表を無効にして同じ比較をして 0 件。**これは乱択での観測で、不変条件ではない**:
    乱択は周期的な(自分と重なる)名前をほとんど出さない。レビューの構造化ファズ(周期的な鍵)は、末尾で重なって 2 回現れる名前で、新が旧より
    少なく伏せる例を約 0.4% で見つけた(旧は ς と σ を別にしていて、偶然伏せていた。同じ形は ASCII の名前でも旧から起きていた)。上の
    「全体に一致するもの」のとおり末尾の端で全体の一致も返して塞ぎ、同じファズ 130,000 件で 0 件になった。設計どおりの例外が 1 つ残る:
    エラー文の先頭で根の全体が一致し、直後が `[\p{L}\p{N}_-]` の文字のとき(根 `/srv/app/ſrv`、本文 `/ſrv/app/srv2 failed` の先頭の `/ſrv`)は、
    新は伏せない(根の直後の文字の条件は本体が持ち、先頭の端は全体の一致を返さない。旧は ſ と s を別にしていて、偶然断片で伏せていた。ASCII の同じ入力
    `/srv/app/srv2` は旧も新も伏せないので、新のほうが規則と一貫している)。欄の途中で重なった出現(`log: -ba1-ba1-ba1-ba done` → `<project>1-ba done`)は
    本体の探索の穴で、旧から同じだった(bdboard-0hj9 で塞いだ。上の「自分と重なる鍵」)。
    鍵ごとに KMP の失敗関数を `prepareKeys` で作っておき、欄の端から鍵の長さぶんだけを読むので、端の探索は欄の長さによらず
    鍵の長さの合計に比例する(敵対的な鍵 = `a` が 500 個の名前 200 件と 1000 個の根 200 件で、1 欄の両端を 1 回調べて約 40 ms。
    2026-10-05、負荷平均 9 前後)。断片が見つかると 2 回目の置き換えが欄全体にもう一度走る。4y8q.13 の時点ではこれで最悪の入力の
    1 欄・5 欄とも約 2 倍になっていたが、根と LONG の名前を文字列探索に替えてからは(上の「探索は…線形に」の段落、bdboard-uudb)1 回の探索が
    数十 ms(現実的な鍵のとき。上の表の敵対的な鍵では組み立て全体で 0.2〜1.6 秒)なので、2 回目の分はわずかしか増えない。
  - **記憶量**: 鍵 1 コードポイントあたり、前向き・逆向きの並びと 2 つの失敗関数で数十バイトを持つ。根の変種(区切り・JSON の `\\`・
    NFC/NFD・パーセント表記)は 1 つの根を数十倍に広げるので、たたんだ後で同じになる変種は 1 つにし、鍵の合計を
    `MAX_FRAGMENT_KEY_CODE_POINTS`(200 万コードポイント)までに抑える(超えた鍵は端の検査に使わず、`truncated` を立てる)。
    上限が無いと、仮名の濁点(NFD が別になる)・漢字・`/` を混ぜた 1024 コードポイントの根 200 件で鍵が約 2,000 万コードポイントになり、
    `prepareKeys` のヒープが 833 MB・最大 RSS が 2.4〜2.8 GB になった(レビューの測定)。上限を入れた後は同じ鍵でヒープ +110 MB・
    RSS 約 230 MB、上の ASCII の最悪の鍵(約 130 万コードポイント、上限の内側)でヒープ +48 MB(2026-10-05)。現実の鍵(根と名前が
    数十件、各 100 コードポイント程度)は数万コードポイントで、数 MB にとどまる。根が先に数えられるので、上限に届く入力では後ろの
    名前の鍵が端の検査から落ちる。なお、同じ CJK の鍵では、当時の置き換え(約 2,800 本の長い `/giu` のリテラル)そのものが
    1 回の組み立てで 117〜184 秒かかっていた(bdboard-uudb で鍵の探索を正規表現から表でたたんだ `indexOf` に替え、約 1〜2 秒になった。
    上の「探索は…線形に」の段落)。

**(b)(保存の上限に当たった欄の末尾の不完全な行を、切ったことを示すフラグを渡して `buildPublicIssueBody` で捨てる)は選ばなかった**:
公開本文の入力の型に保存側の事情を足すことになり、フラグを渡し忘れた呼び出し(4y8q.4 の配線、手で編集した欄)では効かない。
末尾だけを取る送り手の切れ目は保存の側からは見えず、フラグを立てられない。(a) は保存の時点で断片を作らず、(c) はフラグなしで端を
調べるので、どこで切られたかに依らない。

**確かめたこと**(`issue-public-fragments.test.ts`・`issue-draft-cut.test.ts`): チケットの再現(偽の値)が、複数行のどの欄でも置き換わる。
50 行ほどのスタック(登録した根と名前・トークン 5 種・メール・ホームのパス・サロゲートの対を含む)を、でたらめな位置で (1) 先頭を
残して行の途中で切る (2) 末尾を残して行の途中で切る (3) `cutKeepingHead` で切る (4) `cutKeepingTail` で切り、断片が置き換えも報告も
されずに残らない(SILENT が 0)ことと、保存値にサロゲートの片割れが残らないこと。同じ入力の全位置(約 3000)で数えると(2026-10-05)、
直す前は行の途中の末尾の切れ目で 1905 件中 1490 件、先頭の切れ目で 1090 件中 780 件が SILENT で、直した後はどちらも 0 件。
(3)(4) は行の境目で切るので、切れ目にかかる一致そのものが無くなる(最後の行の途中だけは (4) でも行の途中で切れ、(c) が拾う)。

**それでも拾えないもの**(下の「カバーしないもの」の分類とは別に、切れ目に固有のもの):
- **先頭が欠けたトークン**(本体だけが残り、形が無い)。末尾だけを取る送り手が最初の不完全な行を捨てるのが対策で(9節)、捨てられない
  とき(4096 を超える 1 行)は残る。
- **完全な形でも置き換わらない位置で切れたトークン**: 英数字に貼り付いた `sk-`・Stripe・`Bearer`・JWT と、`_` `-` に貼り付いた JWT
  (`id1sk-proj-abc`・`id_eyJabc`)が、さらに欄の末尾で切れたもの。貼り付いた完全な形は最後の網が報告するが、切れた形は短すぎて報告も
  されない(重ならない 2 つの偶然)。開始の条件を外すと `risk-free` のような文章を消すので、完全な形と同じ条件に揃えている。
- **メールのローカル部の途中で切れたもの**(`@` が無く、形が無い。ローカル部が登録した名前なら名前の前置部分として拾う)と、数字で始まる
  ドメインの途中で切れたもの(`deploy@10.0`。パッケージの版 `react@18` と区別できない)。
- **先頭が欠けたホームのパス**(`rs/jdoe/x`)のユーザー名。ユーザー名を固有名詞として登録していれば後置部分として拾う。
- **端に飾りが付いたもの**: 端の検査は「ちょうど端」だけを見るので、断片の後(末尾)に切れ目の印や閉じ記号が付くと拾えない:
  `…`・`...`・` [truncated]`・改行の後の `[truncated]` や `... (truncated)`・`…(省略)`・閉じ引用符 `"` `'`・`` ` ``・コードフェンス
  ` ``` `・途中で切れた ANSI のエスケープ(`\x1b[`)。先頭も同じで、断片の前に `…`・`...`・`[truncated]` の行・空白・タブが付くと
  拾えない(末尾の空白・改行・NBSP・ZWSP・U+2028 は整形で落ちるので問題ない)。末尾を取った出力を自由記述の欄(症状・エージェントの
  メモ)に入れたときの先頭も見ない。どれも送り手の規則(9節)で防ぐ: 行の境目で切り、不完全な行を捨ててから印を付け、末尾を取った
  出力はエラー文の欄だけに入れる。
- **鍵の合計が上限を超えたとき**の、後ろの鍵の断片(上の「記憶量」)。
- **消しすぎ**(拾えないものではなく、断片でないものを消す): 欄の末尾の語が登録した名前・根の 4 コードポイント以上の前置部分に
  一致するとき(名前 `example-project` で末尾が `… the example`)、エラー文の先頭の語が後置部分に一致するとき(`user not found` と
  名前 `example-user`。根が `…/app` や `…/web` で終わる構成で、Docker の Node の未捕捉例外のように `/app/src/index.js:5` で始まる
  エラー文の `/app`)、欄の末尾が `AKIA…`・`npm_…`(`npm_config` も)・`sk-…`(`import sk-learn`)・`Bearer xxxx`・`jdoe@`・`word%` の
  短い形のとき、パッケージの dist-tag(`npx pnpm@latest`・`npm i react@next`・`pkg@canary`。版の数字 `react@18.2.0` は残る)で
  終わるときは、断片でなくても `<redacted-fragment>` になる。1 つの端で消えるのは最長の鍵の長さまでなので、本文が読めなくなることは
  無い。公開本文では過剰な除去を選ぶ。

### 置き換え漏れの検出(疑いのフラグ、判断はしない)

置き換えが効いたかではなく、**組み立て後の最終の題名・本文**(コードスパンの区切りなど固定の雛形を含む)に対し、
置き換えで使った探索をすべて**独立にもう一度**かける(`detectSuspectedLeaks`)。印(`RedactionMark`)が覆っている範囲の
一致は漏れではない(印の文字列が名前の一部と偶然一致するだけ)ので除く。それ以外が `suspectedLeaks`
(`field`・`kind`・`start`・`end`・`matched`)に残る。検出するもの:

- 4 コードポイント以上の固有名詞(置き換え済みのはずなので、ヒットは実装の取りこぼしを示す)。
- 2〜3 コードポイントの固有名詞(**置き換えない代わりに、ここで人に知らせる**。単語として現れたときだけ)。
- プロジェクトの根のパス・ホームのパス・トークン・秘密鍵ブロック・メール。
- **緩い版のトークンの形**(報告だけで置き換えはしない): 置き換えは「語の途中の `sk-`・`Bearer`」を除くために直前の条件を
  付けているが、検出ではその条件を外し、英数字が貼り付いた `sk-…`・`Bearer …`・`sk_live_…`、貼り付いた JWT(2 つ目の部分
  `.eyJ….署名` から)と小文字の `akia…`/`asia…` も報告する。
  このため `task-force-…` のように `sk-` で終わる長いハイフン付きの語は**過剰に報告する**(設計どおり)。
- **緩い版のホームのパス**(報告だけで置き換えはしない): 置き換えは直前が ASCII の英数字のパスを別の語の一部とみなして
  残すが(規則 2)、検出では開始位置の条件を外し、`/Users/<名前>`・`/home/<名前>`(大文字小文字を区別する)と
  `X:\Users\<名前>`(`Users` の大文字小文字は問わない。ドライブ文字の前置きは URL の経路にならないため)の形を
  すべて報告する。置き換えがすでに拾った範囲は二重に報告しない。名前は区切り・空白・引用符・`:;,|<>()[]{}=` で終わる。
- **単独の秘密鍵マーカー**: 完成した本文に `-----BEGIN … PRIVATE KEY-----` や END が1つでも残っていれば、それ自体を報告する
  (置き換えは必ずどれかのブロックに入れるので、残るのは実装の取りこぼし)。
- **`key-overflow`**: 手元の鍵を上限で落としたとき(上の「上限と fail-closed」)。位置は無い。
- 固定の雛形の語が固有名詞と一致した場合も報告する(過剰に検出する側。たとえば名前が `hook` のとき)。

これは best-effort であり、唯一の防御にはしない(エピック決定どおり「投稿の前に毎回人が見る」が本来の防御)。

**カバーしないもの**: 敵対的な入力 70 件(p1)で確かめた結果の移り変わり(2026-10-04): 最初のレビューの時点では 58 件が
素通り(SILENT)・2 件が報告・10 件が置き換え、2 回目のレビューの時点では 16 件が素通り、最後の修正のあとは
**15 件が素通り・3 件が報告のみ(英数字に貼り付いた `sk-`、小文字の `akia…`、`/export/home/<名前>`)・52 件が置き換え**。
素通り(置き換えも報告もされない)のものは次の分類に当たる。直さないと決めたもので、いずれも「投稿の前に人が見る」で拾う前提:

- **改行で割れたもの**: 2 行に割れたトークン、LF で割れた固有名詞(探索は連続した 1 つの文字列にかかる)。
- **全角・互換文字の変種**: `ｇｈｐ＿…`(全角のトークン)、`ｅｘａｍｐｌｅ－ｐｒｏｊｅｃｔ`(全角の名前)。NFKC には正規化しない
  (NFC/NFD の変種だけを探す)。
- **ドットの無いメール**: `admin@example-box` のような `user@host`(ドット付きのドメインを要求する)。
- **JSON の `\uXXXX` で書かれた固有名詞**。
- **大小文字の特殊な対応**: トルコ語の `İ`、`ß` と `SS`(`i` フラグの単純な大小文字の対応にないためカバーしないもの)。
- **1 つの名前の中で NFC と NFD が混在**するもの。
- **短い(2〜3 コードポイント)名前**: CJK の文章の中(前後が文字なので単語にならない)と、数字が貼り付いた ASCII
  (`bob01`)。短い名前は単語として現れたときだけ報告する規則のため。
- **空白を含む名前の、ブロック中での空白の違い**: 鍵は 1 行の整形で空白の連なりが 1 つにされるが、ブロックの本文は空白を
  畳まない(タブは空白 2 つ)ので、本文で連続した空白やタブで書かれた名前は一致しない。
- **ホームの別の配置**: `C:\Documents and Settings\<名前>`、`~名前/`。(`/export/home/<名前>` は置き換えないが、`/home/<名前>` の形として
  最後の網の緩い検出が**報告する**ので、素通りではない。)
- **アポストロフィを含む名前**: `C:\Users\O'Brien` は `O` で切れて `Brien` が残る。
- **AWS のシークレットキー**(40文字)、**未知の秘密の形式**、**別のトークンに貼り付いたトークン**。
- **符号化・書式の変種**(2 回目の再レビューの敵対的な入力 p10 で、直したあとも置き換えも報告もされずに残った 6 件): **二重のパーセント表記**
  (`%252F`)、JSON の **`\u002F`** で書いた区切り、**全角のスラッシュ**、**UNC の管理共有**(`\\host\C$\Users\<名前>`)、空白を **`+`** で
  書いた名前、**マーカーの無い鍵の本体**(PKCS8 の base64 だけなど、BEGIN も END も失われたもの)。いずれも直さないと決めたもの。
  PEM のダッシュが 3 個のもの・ラベルにハイフンを含むもの(`EC-X PRIVATE KEY`)は上の規則 4 のとおり置き換える。
- **最後の再レビューで挙がった素通りの形**: 区切りの一部だけをパーセント表記にした混在(`%2FUsers/jdoe`・`/Users%2Fjdoe`)、
  英数字に貼り付いた小文字の `users/…`(`api/users/jdoe`。通常の URL の経路を報告しないため)、英字で始まるラベルが無い
  メール(`jdoe@example.123`・`jdoe@10.0.5`。パッケージの版 `react@18.2.0` と区別できないため)。いずれも稀で、直さないと決めたもの。

これらとは別に、**3 本目の連鎖**(上の「2 回目の置き換え」の限界)は、置き換えられないが**報告はされる**(上の分類は報告もされない)。

### 4y8q.2 の範囲外(後続で扱う)

4y8q.4 の投稿の前提だった bdboard-4y8q.13(保存側の切り出しで欄の端に鍵の断片が残る問題と、保存側の UTF-16 の切り出し)は、
上の「欄の端の断片」で扱った。

- **配線**: `LocalOnlyKeys` のうち、ユーザー名・ホスト名・ブランチ名は、今の受け取りパイプライン(`finalize` /
  `buildProvisionalDraftText`)の入力に無い。このチケットでは関数だけを作り、`finalize`/`buildProvisionalDraftText` は
  変更しない。配線するときに、これらの値を呼び出し側(サーバー)で集める入力を足す必要がある。
- **保存側の UTF-16 の切り出し**(4y8q.13 で直した): 保存時の `cutTextFrom`/`capFreeText`/`capErrorTextRaw`/`summarizeErrorText` は、
  長さを UTF-16 コード単位で数えたまま、切れ目をサロゲートの対の手前へ寄せる(`issue-draft-cut.ts`)。

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

同じ理由で、レンダリング後のプレビューでは見えない内容(HTML コメント、ゼロ幅・双方向制御
文字、長い base64 など)が自分の下書きの自由記述欄に入っていても、プレビューだけ見て投稿すると
そのまま公開される。投稿前の確認画面(4y8q.3/4y8q.4)では、自分の下書きにも8節の機械の検査を
当てて結果を表示し、プレビューとは別に見えない文字を可視化した生の本文を見せる。

### 実例での確認(4y8q.2 の受け入れ基準)

PicRill-fbs の本文(作業フォルダ名・ポート番号・プロジェクト名入りのエラー文)を材料に、
`buildPublicIssueBody` を通した結果に固有名詞が残らないことを**実物で**確認する。実例の文面そのものは
テストにもリポジトリにもログにも書き込まない(公開リポジトリに注入先の固有名詞を残さないため)。確認は
リポジトリの外の使い捨てスクリプトで行う: チケットを読み取り専用(`bd -C <PicRill のパス> show <id> --json`)で読み、
プロジェクト名・ユーザー名・ホスト名・作業フォルダ名・ブランチ名から機械的に `LocalOnlyKeys` を作って通し、
**真偽値だけ**(固有名詞が残ったか・ホームのパスが残ったか・`suspectedLeaks` が空か)を表示する。
リポジトリのテストに置く値は CLAUDE.md の example-user 規約どおり明らかに偽の形にする(こちらは GitGuardian の
検出器が値ではなく形で発火するのを避けるための規約で、理由が別である)。トークンの形のテスト値は
`'ghp_' + 'x'.repeat(36)` のように実行時に組み立て、秘密のスキャナーに引っかからないようにする。

2026-10-04 の実行結果(4y8q.2、Opus レビューの指摘を直したあとの再実行): 完全な名前(プロジェクト名・作業フォルダ名・
ユーザー名・ホスト名・ブランチ名。固有名詞 27 件、根はプロジェクトの根と作業フォルダ)を鍵にした場合、固有名詞・ホームのパス・
根・メールのどれも残らず、`suspectedLeaks` は空だった。ブランチ名を `/` で割った2〜3文字の部品(一般語を含みうる。固有名詞 63 件)まで
鍵に入れると、それらは置き換えない規則(上記)のとおり本文に残り、検出だけが13件(すべて `branch` の短い名前)報告された。
この13件は、短い名前を置き換えず報告で知らせる設計の想定どおりの動作で、直す対象ではない。

## 6. 投稿(項目 f、bdboard-4y8q.4)

`POST /api/issue-reports/drafts/:id/publish`(3節の認可)。

### 実際の投稿操作はブラウザに委ねる(Opus レビュー Blocker B1 への対応)

3節で述べたとおり「ローカル直アクセスのみ」というネットワーク層の判定だけでは、
「人間が実際に確認して投稿した」ことを保証できない(`curl` 一発で同じガードを通過できる)。
エピック決定「確認なしの自動投稿は作らない」を構造的に満たすため、**実際に GitHub へ issue を
作る操作は `gh issue create --web`/`gh issue comment --web` に委ね、投稿ボタンの押下は
「ブラウザを開くところまで」に留める。** `--web` はローカルの既定ブラウザで GitHub の
「New issue」フォーム(コメントなら issue のコメント欄)を開くだけで、実際の作成
(GitHub 側の "Submit new issue" ボタン)はその後ユーザーが実物のブラウザ上で行う。
bdboard サーバープロセスや、それを叩く何らかのローカルプロセスが単独で issue を作り切る
ことが構造的にできなくなる(この設計はトンネル越しに動く可能性のあるチャットエージェント等
からのエスカレーション経路も同時に塞ぐ — 道具を持つエージェントがこの API を叩けても、
ブラウザでの人間の最終クリックまでは issue が実在しない)。

手順:

1. ガード: `isLocalBasicAuthRequest` でなければ 403 + 画面はボタンを出さない(理由を表示)。
   このガードはブラウザを開く操作自体(GitHub 側のセッションで何が見えるか)をローカル外から
   起動されないようにする目的で維持する。
2. `gh --version`/`gh auth status` を確認(`gh` 自体が無い、または未ログインなら 424 相当で
   案内を返す。check-gh-issues.mjs の `failureReason` と同じ「落ちずに理由を返す」流儀)。
   `--web` でも gh はコマンドを動かす前に自分のログインを要求するので、`gh auth status` は
   投稿の前提条件である(gh 2.86.0 で、未ログインの `gh issue create --web` が
   `gh auth login` の案内を出して止まることを確認)。後述の類似 issue 検索(読み取り専用 API)
   にも `gh` の認証が要る。なお実際に issue やコメントを作るのは、ブラウザで GitHub に
   ログインしているアカウントであり、gh にログインしているアカウントとは別でありうる。
3. 似た issue の検索(投稿前に必ず1回、読み取り専用 API なのでこの手順は従来どおり):
   `gh issue list --repo xiaotiantakumi/bdboard --search "<title の主要語 or catalogSlug>"
   --state all --json number,title,state --limit 10`。この検索は8節(評価エージェントへ渡す
   類似チケット探し)と共通の `findSimilarIssuesAndTickets(query)` ヘルパーに集約し、
   4y8q.4 と 4y8q.10 の両方から呼ぶ(別々に実装しない)。
4. ユーザーが「新規」か「既存 issue にコメント」かを選ぶ(画面側)。コメント本文も5節の
   `buildPublicIssueBody` 相当の置き換えを通す。
5. 新規 issue の本文は一時ファイル経由で `gh` に渡す(`gh issue create --repo
   xiaotiantakumi/bdboard --title "<title>" --body-file <tmp> --web`)。gh は題名と本文を
   `issues/new?title=…&body=…` のクエリに入れてブラウザを開く(gh 2.86.0 で確認)。
   コマンド置換で直接埋め込まない — 添付画像 API の教訓(question-template.md の macOS
   `ARG_MAX`)を踏襲する。実行は `CommandRunner`(シェルを経由しない `spawn` に引数の配列を
   渡す)経由なので、題名や本文によるシェルインジェクションも起きない。
   **既存 issue へのコメントは本文をあらかじめ入れられない**: `gh issue comment` は `--web` と
   `--body`/`--body-file`/`--editor` を一緒に指定できない(gh 2.86.0 で
   `specify only one of --body, --body-file, --editor, or --web` で拒否されることを確認)。
   `gh issue comment <N> --repo xiaotiantakumi/bdboard --web` は
   `issues/<N>#issuecomment-new` を開くだけなので、コメントのときは置き換え済みの本文を
   画面のコピー用テキストエリアに出し、ユーザーがブラウザの欄へ貼る(手順6の長文のときと
   同じ欄を使う)。
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
   ならない — 手順3の似た issue 検索が次回の重複防止を担う)。この URL 確認の受け口も、
   受け口・投稿と同じく**ローカル直アクセス限定**(3節)にする — 下書きを `posted` にし、
   手順8で元チケットへの `bd comment`/`bd close` を起こす書き込み操作のため。
8. URL 確認(手順7)が完了した直後、`sourceTicketRef` があれば(4y8q.7 由来)、
   元プロジェクトの bd チケットへ `bd comment <ref> "issue: <url>"` → `bd close <ref>` を
   実行する。**ref の前に `--` を置く**(`bd comment -- <ref> "issue: <url>"`、`bd close -- <ref>`)。
   受け取りの入口で `sourceTicketRef` は `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$` に絞ってある(3節)が、
   手元のファイルを直接書き換えられた場合や将来の入口の変更に備え、ref がオプション
   (`--db=/tmp/evil` など)として解釈される余地を、実行側でも残さない。
9. gh 呼び出しはすべて `--repo xiaotiantakumi/bdboard` を明示し(実行時の `cwd` の git
   remote に依存しない)、非対話実行であることを保証するため環境変数
   `GH_PROMPT_DISABLED=1` を付ける(`CommandRunner` の `env` は子プロセスの環境変数を
   丸ごと置き換えるので、継いだ環境に足した形で渡す。`HOME` 等が消えると gh が自分の
   認証情報を見つけられない)。新しいポート `IssuePublisherPort`
   (`createGhCliIssuePublisher`)経由にし、`infrastructure/gh/` に置く。`child_process` は
   `infrastructure/process`/`infrastructure/runners` からしか import できない
   (`.dependency-cruiser.cjs`)ので、既存の `createGhCliPrStatusReader` と同じく
   `child_process` を直接 import せず、`CommandRunner` を引数で受け取る形にする。

テストでは `gh` 呼び出しを偽物(fake `CommandRunner`)に置き換え、本物のブラウザや issue は
一切起動・作成しない(4y8q.4 の受け入れ基準どおり)。

## 7. bd への取り込み(項目 g、bdboard-4y8q.4 の一部)

「bdboard 自身の bd が使える環境(メンテナ環境)」の判定は、bdboard がスキャンしている
どれかのプロジェクトの話ではなく、**bdboard サーバー自身の `repoRoot` に `.beads/` が
存在するか**で判定する(`isMaintainerEnvironment(repoRoot) = fs.existsSync(path.join(repoRoot,
'.beads'))`)。npm でインストールした環境ではこれが存在せず、投稿だけで終わる。

投稿が確定した直後(6節手順7 で issue の URL を確かめ `status='posted'` にした直後。
`--web` を起動した時点ではまだ issue が無いので、その時点では作らない)、メンテナ環境なら追加で:

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
| ★★★★★ | 優先的に対応すべき | **P2**(P1 への昇格は人間の明示操作でのみ。下の「prompt injection で判定を覆されたときに何ができてしまうか」の理由 — エージェントの出力を無条件に最上位優先度へは直結させない) |
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

**取り込み後の bd チケットには `external-untrusted` ラベルを付け、自律セッションが着手候補を
取る `bd ready` の既定の呼び方から外す。** ハーネスの SKILL.md 規律1 手順5・session-start.md
手順5 と AGENTS.md の Quick Reference にある `bd ready --exclude-label gt:slot` を
`--exclude-label gt:slot,external-untrusted` に広げる(`--exclude-label` は「どれかのラベルを
持つものを除く」複数指定のフラグ。AGENTS.md の該当行は `bd init`/`bd setup` が再生成する
管理ブロックの中にあるので、`.claude/rules/bd-init-agents-md.md` の確認手順も守る)。
Runner(`POST /api/runs`)は人が対象チケットを指定して起動するもので、`bd ready` から自動で
拾う経路は元々無い。人間がチケット本文を読み、必要なら自分の言葉で書き直してこのラベルを
外すまでは、実装エージェントに自動的には渡らない(下の段落の理由)。

### prompt injection で判定を覆されたときに何ができてしまうか(Opus レビュー観点への回答)

両エージェントとも同じ攻撃者制御下の本文を読むため、独立呼び出しであっても
「1体目が `safe` に、2体目が `★5` に、両方とも欺かれる」最悪ケースはあり得る。両エージェント
自身はファイル・コマンド・ネットワークに触れないので、判定を欺いても両エージェントの実行時に
任意コード実行やデータ持ち出しが起きることはない。**ただし「被害の天井は bd チケット1件」
という言い方は不正確だった**: 取り込みボタンを押すと作られる bd チケットは、`bd ready` に
そのまま乗る。ハーネスに従う自律セッションは `bd ready` の候補から着手し(SKILL.md 規律1)、
セッション自身の道具一式でそのチケット本文を読んで作業を始めうる。ハーネスの規律には
チケット本文を信頼できない入力として扱う定めが無い。Runner の側は、ARCHITECTURE.md
「チケット本文は信頼できない入力」のとおり、実行プロンプト(`build-run-prompt.ts`)で
`bd show` の出力に書かれた指示には従わないよう明示し、道具も3層で最小化している。ただし
これはプロンプトでの指示であって構造的な保証ではない。欺かれた★5評価がそのまま P1 に
直結すれば、攻撃者が仕込んだ文面が作業キューの先頭に来てしまう。
これが実際の懸念であり、対策は上の2つ: (1) 自動優先度を P2 で頭打ちにし P1 は人間の
明示操作のみ、(2) `external-untrusted` ラベルで `bd ready` の既定の候補から外し、
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
- 同じ ARCHITECTURE.md のポートの表で、`AgentRunner` の行が「`POST /api/runs` の1経路のみ」と
  書いている。新しい経路(判定エージェント)の行を足すときに、この行も食い違わないよう直す。

## 9. ハーネス側の変更(項目 i、bdboard-4y8q.12)

- **layering.md「アップストリーム経路」節**: 手順1〜3(`bd create --type=task
  --title="[harness-upstream] ..."` → `bd label add harness-upstream` → bdboard 側が
  ラベルで拾う)を、`scripts/report-issue.sh` の直接呼び出しに置き換える。宛先解決は
  question-template.md の添付画像 API と同じ(既定 `http://localhost:8787`、
  `BDBOARD_PORT` を変えている構成ではそのポート)。bdboard が止まっている場合は
  1秒で諦めて失敗を返し、エージェントはその中身を作業の最終報告に残す(スクリプトが
  失敗を返す設計なので、hook 側で無理にリトライしない)。
  「暫定運用として project-harness にもエントリを置いてよい」の文言はそのまま残す。
- **brushup-protocol.md**: 汎用の教訓の運び先を「`harness-upstream` チケット」と名指しして
  いる3箇所(「規律5 の手順(全文)」の手順4、「役割分担」節の「正本はこの repo の skill」の
  段落、§3 前段の「汎用の教訓は harness-upstream チケットで運ぶ」)は、layering.md を
  書き換えると食い違うので、報告スクリプト(layering.md のアップストリーム経路)を指す文に
  書き換える。同じ「規律5 の手順(全文)」の手順3「直せないなら起票して現作業へ戻る」
  (自プロジェクト内の `bd create --type=task ... harness`。§1 末尾にも同じ趣旨の一文がある)は
  公開 issue の話ではないので変更しない。
- **SKILL.md と pack.json**: SKILL.md「機械ガード(hooks)」節の「hook/deny に止められたら
  …不具合は `harness-upstream` へ」(種類 B の入口そのもの)と、pack.json の `description` の
  「harness-upstream 還流」も、同じ置き換えの対象に含める。
- **hook からの送信の前提は main で変わった**: 0.56.0(bdboard-cm2q.10、PR #816)で、
  コマンド文字列を正規表現で読む hook 4本(pre-bash-guard / pre-edit-guard / server-guard /
  worktree-owner-guard)は廃止され、`permissions.deny`・`isolation: worktree`・merge-pr の
  前提条件に置き換わった。配布する hook は stop-ticket-gate.sh と worktree-freshness.sh の
  2本だけで、jq も python3 も無いと全検査を飛ばして通す(fail-open)のは stop-ticket-gate.sh
  である。hook 本体の合計行数には予算がある(`src/infrastructure/harness/hook-line-budget.test.ts`。
  上限 663 行、2026-10-04 時点で 602 行)。bdboard-4y8q.12 の「判断できずに通したときに hook
  から送る」は、この2本のどれから何を送るかを決め直し、行数は brushup-protocol.md §4 の
  4問目(代わりに外すもの)と §7 の予算に従う。
- **古い版のハーネスが残る間の共存**: 旧版(bdboard 以外の5プロジェクト)は当面
  `bd create ... harness-upstream` のままになる。bdboard-4y8q.7 がこれを定期的に走査して
  下書きへ取り込む(bdboard-4y8q.1 に依存)。新版に更新したプロジェクトから順に
  `report-issue.sh` の直接送信へ切り替わり、`harness-upstream` チケットは自然に減っていく。
- **出力を切って送るとき(head・tail-capture)**: どの欄でも、長い出力を切って送る hook・スクリプト(先頭を取るものも末尾を取るものも)は、
  行の境目で切り、不完全な行を捨ててから切れ目の印(`…`・`[truncated]` など)を付け、サロゲートの対(シェルならマルチバイト文字)を
  割らない(`issue-draft-cut.ts` の `cutKeepingHead`・`cutKeepingTail` と同じ規則)。末尾を取った出力はエラー文の欄だけに入れる
  (公開本文が先頭の断片を探すのはエラー文だけ)。先頭が欠けたトークンは本体だけが残って形が無く、断片の後に印が付くと端の検査が
  届かず、どちらも公開本文の側では拾えないため(5節「欄の端の断片」の「それでも拾えないもの」)。
- **pack.json のバージョン**: layering.md 自身の規約(配布スクリプトの挙動が絡む変更は
  patch ではなく minor)により、この変更は **minor** で上げる。
- 規則文書の文面は `model: fable` の最大 effort(選べなければ `opus` で最大熟考)で書く —
  この節の実装(bdboard-4y8q.12)側の受け入れ基準であり、本ドキュメント自体はその対象ではない
  (本ドキュメントの執筆モデルは末尾「メタデータ」節を参照)。

## 10. 未決事項まとめ

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | issue-drafts の既定保存パス | (解決済み)727y が PR #782 で基点解決関数 `resolveDataDirBase` を入れた | `<基点>/issue-drafts/`(2節) |
| 2 | 道具ゼロ判定(`--tools ''` + `--strict-mcp-config` + `--setting-sources ''`)が実際に道具ゼロを達成しているか | (a) 組み合わせを信じて実装 / (b) 実装時に実測して確定 | (b)。ARCHITECTURE.md の既存注記と同じ理由(8節) |
| 3 | 安全判定・⭐評価に使うモデル | 高精度重視(opus 等) / 低コスト重視(sonnet 等) | 安全判定は誤判定のコストが高いので高精度側、⭐評価は軽量タスクなので低コスト側。具体名は実装時にユーザーと相談 |
| 4 | 新規下書きの1時間20件の数え方 | 暦時間バケツ(実装簡単・境界で緩む) / 真のスライディングウィンドウ(厳密・実装重い) | 暦時間バケツ(4節)。小さな決め事なので実装時に変更してよい |
| 5 | `gh issue create --web` のプレフィル URL 長の実際の閾値(6節手順6) | 実装時に `gh`/ブラウザの実測値で確定 | 実測して確定。超過時の「要約+手動貼り足し」フォールバック(6節)自体は確定事項とする |
| 6 | 外部 issue 取り込み時の per-field 上限(title 300字/body 20000字、8節)の具体値 | この値のまま採用 / 実装時に調整 | このまま採用してよい(セキュリティ境界ではなくコスト制御が目的のため、実装時の微調整を妨げない) |
| 7 | issue 一覧の読み込み時に走る初回評価のエージェント呼び出し回数 | 上限なし / 時間あたりの回数・費用の上限を置く | 上限を置く。外部の誰でも issue を量産して呼び出しを起こせるため。具体値は 4y8q.10 の実装時に決める |
| 8 | 子チケットの本文とこの設計の食い違い(4y8q.4 は `gh issue create` 直接実行・確認ダイアログ・gh アカウント名表示を前提、4y8q.10 は ★5→P1) | チケット側に合わせる / この設計に合わせる | この設計(`--web` とブラウザ側のアカウント、自動付与は P2 まで)を正とし、各チケットの着手時に本文を書き換える |

## 11. 実装チケットの進め方

エピックの `bd children`/`bd dep` にすでに表れている依存関係を、着手順の目安として並べる
(依存が無い列は並行可)。

| 順 | チケット | 内容 | 前提 |
|---|---|---|---|
| 1 | bdboard-727y | 添付画像の保存先バグ修正(完了: PR #782、2026-09-25 マージ) | なし |
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

2026-10-04 に Opus 5.5 がレビューし、main(origin/main 43fb3a15)と照合して事実の誤りと
古くなった記述を直した(2節を 727y の実装に合わせた、3節の先例、6節の gh `--web` の挙動、
8節のチケット本文の扱い、9節の置き換え対象と hook の前提)。設計判断は変えていない。
記録は `bdboard.model.review=opus-5`。
