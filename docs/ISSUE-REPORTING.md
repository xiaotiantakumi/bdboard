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
  titleEditedByUser: boolean;             // true なら次の同一指紋マージ時も自動再生成しない
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
| 閲覧・編集・見送り | `GET /api/issue-reports/drafts`、`GET .../:id`、`PATCH .../:id`、`PATCH .../:id/dismiss` | 不具合報告タブの UI | PATCH は通常の write-guard(ローカル直 または 強パスワード+セッション Cookie のトンネル)。GET は `createWriteGuardMiddleware` の対象外(メソッドで素通しする)なので、ほかの読み取り API と同じく、トンネルではトンネルの認証(Basic 認証)を通れば読める(パスワードの強度は問わない)。**ただし `GET .../:id` だけは、全部を返すのはローカル直アクセスのみ**(下の「1 件の取得はトンネルでは絞る」) |
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
`sourceTicketRef`、`harnessVersionAtOccurrence`、`draftSchemaVersion`、`restricted`。画像の一覧は別の API。
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
引用符・リストの区切りと括りの開閉(`` ` `` `:` `;` `,` `|` `<` `>` `)` `[` `]` `{` `}` `=`)・改行・文字列の終わりで終わる。だから
`/home/u:/home/u/bin` は `~/:~/bin`、`x=/Users/u;y=/Users/u/z` は `x=~/;y=~/z`、`C:\Users\u;C:\Users\u\bin` は `~/;~/bin`
になり、区切りの先の次のパスも別々に畳まれる(名前の欄にこれらの文字は入らないので、巻き込まない)。ただし Windows の名前だけは
半角スペースを含みうる(`John Smith`)ので、上の止まる文字・改行・文字列の終わりまでを名前として読む(改行は名前に入れない:
複数行の本文で、次の行以降を巻き込んで消さない): **`bash C:\Users\u --flag` は `bash ~/` になる**(引数を残すより、
ユーザー名を残さないことを優先する)。ただし**半角スペースの直後が `X:\`・`X:/`(ドライブ文字)か `/`・`\` のときは、
次のパスの頭なので、そのスペースで名前を終える**: `cd C:\Users\u && node C:\Users\u\x.js` は `cd ~/ ~/x.js`、
`C:\Users\u D:\Users\u\x` は `~/ ~/x`、`cp C:\Users\u /home/u/x` は `cp ~/ ~/x` になり、次のパスも別に畳まれる
(以前は次のパスの頭を名前に飲み込み、`cd ~/:\Users\u\x.js` のように次のユーザー名が残った。bdboard-4lea)。
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

未対応で残るもの: 画像(`GET .../images/:fileName`)はトンネルの Basic 認証だけで読める。スクリーンショットに
秘密が写りうるという点で同じ種類の問題だが、画像の扱いは 4y8q.3 の画面設計と合わせて決める。

### 閲覧・編集(PATCH)側のフィールド範囲

3節冒頭の表で「閲覧・編集・見送り」はトンネル経由(強パスワード+セッション Cookie)でも
許可しているが、これは「編集画面を使わせる」ためであって「任意のフィールドを書き換えて
よい」という意味ではない。`PATCH /api/issue-reports/drafts/:id` が受け付けるフィールドは
次に限定し、それ以外のキーを含むリクエストは 400 で拒否する:

- `title`、`body`、`titleEditedByUser`、`bodyEditedByUser`(いずれも公開前の編集用)。**`title` と `body` の
  長さは入口(4y8q.3)で上限を掛ける**: `draft.json` は 200KB まで(4節「上限」)で、縮めるのは
  生ログ・一覧・メモなどだけ。題名・本文は縮める対象にしていないので、保存層は 200KB を超える下書きを
  黙って書かずに断る(`save` が投げる)。入口で止めないと、編集の保存が 500 になる
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
| `pending` の下書きあり | 新規作成しない。`occurrenceCount+=1`、`lastOccurredAt` 更新、`occurredProjects` に無ければ追加。`titleEditedByUser`/`bodyEditedByUser` が false なら5節の関数で `title`/`body` を再生成(件数・最終発生時刻の反映) |
| `dismissed` の下書きあり | 新規作成しない。`occurrenceCount+=1` のみ(エピック決定どおり) |
| `posted` かつ issue が open(4y8q.5) | 新規作成しない。「その後 N 回起きた」を表示、issue へコメントを足すボタンを出す |
| `posted` かつ issue が closed(4y8q.5) | 「再発(#N は閉じ済み)」として新規下書きを作る |

「大量発生」の下書き(下の「上限」)も同じ表に従う。`dismissed`(と、4y8q.5 までの `posted`)の
「大量発生」には、さらに丸め込まれる新規指紋が来ても `occurrenceCount+=1` だけで、題名・本文・
`foldedFingerprints`・最終発生時刻・プロジェクトは触らず作り直しもしない。

### 上限

- 1件のテキストサイズ: 手元保存の `errorTextRaw` 自体にも上限を設ける(64KB。超過分は
  末尾から切り詰める)。表示用の `errorTextHead`/`errorTextTail`(各 1000 文字、
  `"…(N 文字省略)…"` を間に挟む)は **この `errorTextRaw` から作る派生値であり、
  5節の置き換え(トークン等の自動置換)は `errorTextRaw` の全文に対して先に適用してから
  1000文字へ切り詰める。** 順序を逆にする(先に1000文字へ切り詰めてから置換する)と、
  トークンが切り詰め境界でちょうど分断され、置換の正規表現(20文字以上を要求するものが
  多い)にマッチしなくなり、断片が置換されないまま公開本文に残る恐れがある。`draft.json`
  全体(画像を除く)は 200KB を上限とし、超過分は末尾から切り詰める(添付画像は別ファイル
  なので影響しない)。**200KB は、ディスクに書く形(整形しない 1 行の JSON + 改行)のバイト数で測る**
  (`serializeDraft`。判定と書き込みが同じ文字列を使う)。削る順は、`errorTextRaw` の末尾 →
  `occurredProjects` の古い行(`lastSeenAt` が古い順)→ `foldedFingerprints` の古い行 → `agentNoteRaw` →
  `symptomRaw` → `causeRaw` → `preventionRaw` の末尾。回数と時刻は別に持つので、一覧の古い行を落としても
  数は変わらない。見送りの理由を足すとき、見送り済みの回数を足すときにも同じ判定をかける。
- 画像: 添付画像 API と同じ検査を流用 — マジックバイト判定、1枚 10MB、1下書きあたり
  20枚まで(`ATTACHMENT_MAX_BYTES`/`ATTACHMENT_MAX_COUNT_PER_TICKET` と同じ定数を共有するか、
  `issue-report` 用に複製して同じ値を持たせる)。
- 新規下書きの件数: **1時間20件まで(種別 A/B/C をまたいだ合計)**。実装は UTC の暦時間バケツ
  (`mass-occurrence:<kind>:<yyyy-mm-ddTHH>`)で数える。21件目以降の新規指紋は個別の下書きを
  作らず、そのバケツの「大量発生」下書きへ丸め込む(`occurrenceCount` を増やし、`localOnly` に
  丸め込まれた元の指紋一覧を追記する。公開本文は「この時間に N 件の類似しない問題が集中発生」
  という一般的な文面に留め、個別の詳細は出さない)。暦時間区切りは実装が簡単な分、境界をまたぐ
  瞬間だけ実質的な上限が緩む(60分の壁時計窓ではなく1時間区切り)。厳密なスライディングウィンドウ
  が要るなら実装時に変更してよい(小さな決め事なので本ドキュメントではブロックしない)。

### 実装との差分(bdboard-4y8q.1、PR #859)

設計(本ドキュメント)と実装の食い違いと、実装中・レビューで決めたことの記録(4y8q.11 の受け入れ基準:
食い違いは実装側の PR で書く)。設計が優先で、ここに無い点は設計どおり。

**設計の文面からの差(PR 本文の 8 件)**

| # | 項目 | 実装 |
|---|---|---|
| 1 | 1時間20件の数え方 | **種別 A/B/C をまたいだ合計**で 1 時間(UTC の暦時間バケツ)に 20 件。設計の文面が種別ごとか合計か曖昧だったので、枠を小さく保つほうを選んだ。「大量発生」は種別 × 時間で 1 件ずつ、20 件には数えない。**注意**: 合計なので、ある 1 種別が 20 件を使い切ると、同じ時間の他の種別の新規指紋は、その種別の個別の下書きが 1 件も無くても「大量発生」に丸められる(1 種別がほかを飢えさせうる)。種別ごとの枠にするかは、実際に起きてから決める |
| 2 | 題名・本文 | 公開してよい題名・本文を作る 4y8q.2 がまだ無いので**暫定の組み立て**: 種別・名前(source / catalogSlug)・回数・時刻・版数だけ。症状・原因・エラー文・プロジェクト名は入れない。4y8q.2 が入ったら `domain/issue-draft-build.ts` の `finalize` を差し替える |
| 3 | 題名・本文の編集(`PATCH .../:id`) | 4y8q.3 に回した。画面 API はチケットどおり一覧・取得・見送りだけ。`titleEditedByUser` / `bodyEditedByUser` は保存形式と再生成の判定には入っている |
| 4 | 画像の追加 | 受け取りの本文を 1 MiB に抑えるため、**1 枚ずつ別のエンドポイント**(`POST .../:id/images`) |
| 5 | `normalizeErrorText` の順 | 時刻の置換を 16 進・行:列の置換より**先**に行う。得られるのは、小数秒ありの `…56.789Z` と無しの `…56Z` が同じ値になること(同じ書式どうしは、どちらの順でも数字が `<n>` になって揃う) |
| 6 | 64KB の生エラー文 | **文字数**で数え(64Ki 文字)、バイトの 200KB を別に掛ける |
| 7 | `posted` への再発 | 4y8q.5 までは、回数を失わないよう `dismissed` と同じく回数だけ足す。`posted` になる経路はこの PR には無い |
| 8 | 見送り(`PATCH .../:id/dismiss`) | 通常の write-guard(ローカル直、または強パスワード + セッション)。ローカル直アクセス限定にしたのは受け取りと画像追加だけ |

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
- **一時的な読み取りの失敗(N5)**: 一覧・取得は、種類が違う・読む権限が無い・壊れている(ENOTDIR・EISDIR・
  EACCES・EPERM・不正な JSON・形や時刻の不正)ものだけを警告つきで飛ばし、EMFILE・EIO のような一時的なものは
  投げる。受け取りの索引は最初の 1 回だけ作るので、欠けた一覧を飛ばして作ると、プロセスの間ずっと既知の指紋が
  二重に作られる。投げれば索引は作り直される。警告には id と理由だけを出し、保存先のパスは出さない。

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

- **Windows の名前は、空白の直後が次のパスの頭なら終える(必須の修正)**: `cd C:\Users\u && node C:\Users\u\x.js` は `cd ~/:\Users\u\x.js` のように、
  次のパスの頭を名前に飲み込んで次のユーザー名が残った。空白の直後がドライブ文字(`X:\` `X:/`)か `/` `\` なら、そこで名前を終える
  (`John Smith`・`bash C:\Users\u --flag` → `bash ~/` は変えない)。3節の「ホーム配下のパス」。
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

- 保存期間・ディスク総量の上限(m-4)。下書きと画像は増え続ける。後続チケットで扱う。
- 手元の `envInfo` を、マージのたびに最新へ更新すること(m-6)。4y8q.3 で扱う。

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

同じ理由で、レンダリング後のプレビューでは見えない内容(HTML コメント、ゼロ幅・双方向制御
文字、長い base64 など)が自分の下書きの自由記述欄に入っていても、プレビューだけ見て投稿すると
そのまま公開される。投稿前の確認画面(4y8q.3/4y8q.4)では、自分の下書きにも8節の機械の検査を
当てて結果を表示し、プレビューとは別に見えない文字を可視化した生の本文を見せる。

### 実例での確認(4y8q.2 の受け入れ基準)

PicRill-fbs の本文(作業フォルダ名・ポート番号・プロジェクト名入りのエラー文)を材料に、
`buildPublicIssueBody` を通した結果に固有名詞が残らないことをテストで確認する。実例の文面そのものは
テストに書き込まない(公開リポジトリに注入先の固有名詞を残さないため)。テストに置く値は
CLAUDE.md の example-user 規約どおり明らかに偽の形にする(こちらは GitGuardian の検出器が
値ではなく形で発火するのを避けるための規約で、理由が別である)。

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
