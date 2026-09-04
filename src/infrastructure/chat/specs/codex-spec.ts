import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ChatAgentError, type ChatAgentAvailability, type ChatImageAttachment, type ChatTurnRequest, type ChatTurnResult } from '../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../application/ports/command-runner.js';
import type { CliChatAgentSpec, CliMcpServerSpec, CliTurnContext, CliTurnPlan } from '../cli-chat-agent.js';

// CODEX_HOME を含める点だけ claude-spec のアローリストと異なる。--ignore-user-config を
// 付けても設定ファイル読み込みが遮断されるだけで、認証情報 (auth.json 等) は引き続き
// $CODEX_HOME 配下から読まれるため、ここを外すと codex login 済みでも未認証扱いになる。
export const CODEX_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'CODEX_HOME'] as const;

export interface CodexSpecOptions { readonly codexPath: string; readonly model: string; readonly timeoutMs: number; }
const codexThreadStartedSchema = z.object({ type: z.literal('thread.started'), thread_id: z.string() });
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

function parseCodexEvents(stdout: string): { readonly threadId: string | undefined; readonly failedTools: readonly string[] } {
  let threadId: string | undefined;
  const failedTools: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (threadId === undefined) {
      const started = codexThreadStartedSchema.safeParse(event);
      if (started.success) { threadId = started.data.thread_id; continue; }
    }
    if (!isRecord(event) || event.type !== 'item.completed') continue;
    const item = event.item;
    // status === 'failed' は権限拒否に限らない(タイムアウトや MCP サーバー側の
    // エラーも同じ status で来る)ため、フィールド名は ChatTurnResult 側と揃えて
    // failedTools とする(bdboard-l1t.4 SF6)。
    if (isRecord(item) && item.type === 'mcp_tool_call' && item.status === 'failed' && typeof item.tool === 'string') failedTools.push(item.tool);
  }
  return { threadId, failedTools };
}

// TOML の基本文字列(ダブルクォート)はリテラルの制御文字(タブを除く)を許さない。
// バックスラッシュ/ダブルクォートのエスケープだけでは、値に生の改行や NUL 等の
// 制御文字が混ざったときに不正な TOML(あるいは -c オーバーライドの意図しない
// キー/セクション分割)を生成してしまう(bdboard-l1t.4 レビュー指摘)。
//
// エスケープではなく reject を選ぶ(bdboard-l1t.4 デルタレビュー nit8 採用): 制御文字を
// \uXXXX 等へエスケープして「常に有効な TOML を作る」実装も可能だが、-c オーバーライドは
// codex-cli 側の TOML パーサーの実装依存であり、エスケープシーケンスの解釈がこちらの想定と
// 完全に一致する保証は無い。ここで扱う値(MCP サーバーのコマンド/引数)は本来 bdboard 側が
// 組み立てる定型データであり、制御文字が混ざっているならそれ自体が想定外の入力("動くが
// 危ういエスケープ"より、"エラーで気付ける失敗"の方が安全)。そのため制御文字を検出したら
// 例外を投げて呼び出しを拒否する。
function tomlEscapeString(value: string): string {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `refusing to build a codex -c TOML override from a value containing a raw control character (U+${code.toString(16).padStart(4, '0')}); MCP server command/args must not contain control characters`,
      );
    }
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function tomlStringArray(values: readonly string[]): string { return `[${values.map((value) => `"${tomlEscapeString(value)}"`).join(', ')}]`; }
const TOML_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

// 2026-08-16 に実測で確認: `-c mcp_servers.<name>.command=...` / `-c mcp_servers.<name>.args=[...]`
// による MCP サーバーのターン単位注入は、$CODEX_HOME/config.toml を一切書き換えずに機能する
// (実行前後で config.toml の md5/mtime が不変であることを確認済み)。bd MCP サーバーは
// 常にこの -c オーバーライド経由で渡し、config.toml への永続書き込みは絶対に行わないこと。
function buildMcpConfigArgs(mcpServers: readonly CliMcpServerSpec[]): string[] {
  const args: string[] = [];
  for (const server of mcpServers) {
    if (!TOML_KEY_SEGMENT.test(server.name)) throw new Error(`unsafe MCP server name for TOML override: ${server.name}`);
    args.push('-c', `mcp_servers.${server.name}.command="${tomlEscapeString(server.command)}"`);
    args.push('-c', `mcp_servers.${server.name}.args=${tomlStringArray(server.args)}`);
  }
  return args;
}

// codex exec には claude の --system-prompt に相当する引数が無い(2026-08-16 --help で実測確認済み)。
//
// 訂正 (2026-08-16 デルタレビューでの実測): 当初「--ignore-rules で AGENTS.md 読み込みも
// 抑止している」と書いていたが誤り。--ignore-user-config --ignore-rules --strict-config を
// 付けた状態でも、cwd(= request.projectRootPath、つまり対象プロジェクトのルート)に置いた
// AGENTS.md の内容がそのままエージェントに見えることを実測で確認した(プロジェクト直下に
// マーカー文字列入りの AGENTS.md を置き、それを一言一句復唱させて確認)。--ignore-rules が
// 抑止するのは execpolicy の .rules ファイルのみで、AGENTS.md や skills の instructions は
// 対象外。
//
// つまり codex 実行時、対象プロジェクトの AGENTS.md/CLAUDE.md は developer 級の指示として
// 注入され得るのに対し、bdboard がここで届けている systemPrompt は stdin 先頭に置いた
// 単なる user テキストでしかない(codex 側にそれを developer/system 相当に格上げする手段が
// 無い)。つまり「プロンプトインジェクション対策の指示チャネルとしては最弱」という前提を
// 崩さずに扱う必要がある — プロジェクト側の AGENTS.md/CLAUDE.md の方が優先度の高いチャネル
// として働きうる、という非対称性を踏まえること。stdin 前置はそれでも「システムプロンプトを
// 一切届けない」よりは良いため、毎ターン実メッセージの前に連結して渡す。resume ターンでも
// 同様(セッションは会話文脈を引き継ぐだけで、system prompt を覚えてくれるわけではないため)。
function buildCodexStdin(ctx: CliTurnContext, message: string): string {
  return `${ctx.systemPrompt}\n\n---\n\n${message}`;
}

function imageExtension(image: ChatImageAttachment): string {
  switch (image.mimeType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
  }
}

function buildImagePaths(images: readonly ChatImageAttachment[], scratchDir: string): string[] {
  return images.map((image) =>
    path.join(scratchDir, `bdboard-codex-image-${randomUUID()}.${imageExtension(image)}`));
}

// 一時画像ファイルの秘匿性について (bdboard-che)。
//
// `mode: 0o600` が実際に効くのは POSIX だけで、Windows の Node は POSIX パーミッションを
// 実装していない — fs は書き込み可能ファイルを一律 0o666 相当と報告し、chmod で操作できるのは
// 読み取り専用ビットだけ (CI 実測: expected 384 (0o600), received 438 (0o666))。ACL を直接
// 触る API は Node コアに無い。
//
// 方針として、Windows では **ACL を明示設定せず、置き場所に依拠する**。ユーザープロファイル配下の
// Temp (`%SystemDrive%\Users\<username>\AppData\Local\Temp`) は、既定の ACL が SYSTEM /
// Administrator / 当該ユーザーだけにアクセスを許す。これは Microsoft の一次情報に明記がある:
//   https://learn.microsoft.com/windows/win32/shell/about-user-profiles
//   「Because the access control list (ACL) of these Temp directories allows access to SYSTEM,
//     Administrator, and the current user, applications need to elevate to access for other users.」
//
// ただしこれは **コードが強制する保証ではなく、環境に対する前提**である。ここに渡る scratchDir は
// `os.tmpdir()` で、Windows での解決順は `TEMP` → `TMP` → `%SystemRoot%\temp` (Node の
// lib/os.js 実装)。つまり前提が崩れる経路が2つある:
//   - TEMP/TMP が共有ディレクトリへリダイレクトされている
//   - TEMP も TMP も未設定で、`C:\Windows\temp` (全ユーザー書き込み可) へフォールバックする
// どちらも既定の Windows では起きないが、「%TEMP% だから安全」と短絡せず、依存している前提を
// ここに書き出しておく。
//
// icacls 相当を毎ファイル呼ぶ案は採らない: 画像1枚ごとに子プロセスを起こすことになり、失敗時の
// 分岐 (icacls が無い/権限が足りない/パスにクォートが要る) がここで扱うには重すぎる。ローカル
// 開発ツールが自分の %TEMP% に置く一時ファイルという用途に対して割に合わない。
//
// `flag: 'wx'` は上とは別の目的で、プラットフォーム共通に効く。既存パスへの書き込みを拒否する
// ので、事前に置かれたファイルやシンボリックリンクを掴まされる経路を塞ぐ (パス名は randomUUID
// なので予測もできない)。POSIX の /tmp のような共有ディレクトリで意味を持つのはこちら。
function writeImageFiles(images: readonly ChatImageAttachment[], imagePaths: readonly string[]): void {
  try {
    images.forEach((image, index) => {
      // POSIX では 0600。win32 では無視される (上のコメント参照) — 害は無いので落とさない。
      writeFileSync(imagePaths[index]!, image.data, { flag: 'wx', mode: 0o600 });
    });
  } catch (err) {
    // buildTurn が plan を返す前の失敗は createCliChatAgent の finally へ届かない。
    // 部分的に作られたファイルをここで必ず片付けてから再throwする。
    for (const imagePath of imagePaths) {
      try {
        unlinkSync(imagePath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('chat codex-spec: failed to remove a partial image artifact');
        }
      }
    }
    throw err;
  }
}

function buildCodexArgs(request: ChatTurnRequest, ctx: CliTurnContext, model: string, lastMessageFile: string, imagePaths: readonly string[]): string[] {
  const sharedFlags = [
    ...buildMcpConfigArgs(ctx.mcpServers), ...(model !== '' ? ['-m', model] : []),
    ...imagePaths.flatMap((imagePath) => ['-i', imagePath]),
    '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check', '--json', '-o', lastMessageFile,
  ];
  if (request.resumeSessionId !== undefined) {
    // 既知の codex-cli 0.147.0 制約: `codex exec resume <id>` の --help には
    // -s/--sandbox も --approve-for-me も出てこず、実際に渡すとエラーになる。
    // つまり resume したターンでは MCP ツール呼び出しを非対話で承認する手段が無く、
    // bd_* 呼び出しは常に "user cancelled MCP tool call" で失敗する
    // (approval_policy="never" 等の -c オーバーライドも試したが効果なし)。
    // bdboard 側で回避策は無いため、そのまま resume 引数を組んで実行する
    // (承認さえ通れば動く形は維持し、次ターンでの改善余地を残す)。
    return ['exec', 'resume', request.resumeSessionId, ...sharedFlags];
  }
  // 新規ターンは --approve-for-me を付ける。これが実測で確認できた唯一の
  // 非対話 MCP ツール承認手段(付けないと全ツール呼び出しが自動拒否される)。
  // --approve-for-me は workspace-write サンドボックスを内部で強制し、
  // 明示的な -s/--sandbox と併用するとエラーになるため -s は付けない
  // (`--approve-for-me` と `-s/--sandbox` を同時指定すると
  // "the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'"
  // で起動自体が失敗する。2026-08-16 codex-cli 0.147.0 で実測確認済み)。
  //
  // 既知の未解決リスク (bdboard-l1t.4 SF4, 2026-08-16 実測、codex-cli 0.147.0):
  // `--approve-for-me` は MCP ツール呼び出しの承認だけでなく、プロジェクト外
  // (例: $HOME 直下)への書き込みを要求するシェルコマンドの sandbox
  // エスカレーション要求も自動承認してしまう。使い捨てプロジェクトディレクトリで
  // 「$HOME 直下にファイルを書け」という指示を与えたところ、エージェントは
  // いったん「サンドボックス外への書き込み許可が要る」旨のメッセージを出しつつ、
  // 実際にそのままコマンドを実行して書き込みに成功した。以下の緩和策をすべて
  // 個別に試したが、いずれも書き込みを阻止できなかった(実測、いずれも exit 0
  // でファイルが実際に作成された):
  //   - -c approval_policy="never"
  //   - --disable guardian_approval
  //   - -c 'sandbox_workspace_write.writable_roots=[]'
  //   - -c 'sandbox_mode="read-only"' (-s/--sandbox の CLI フラグ自体は
  //     --approve-for-me と併用不可だが、-c 経由の同名 config キーは
  //     エラーにならず受理される — にもかかわらず効果は無かった)
  // つまり `--approve-for-me` は「MCP ツール呼び出しの自動承認」だけでなく
  // 「サンドボックスエスカレーションの自動承認」も一体不可分で行っており、
  // 現時点で判明している -c オーバーライドの組み合わせでは前者だけを有効にして
  // 後者を無効化する方法が無い。これは codex アダプタの capability を
  // 'unrestricted' として正直に申告している理由の一部でもある(shell/ファイル
  // 読み書きは元々可能な設計だが、実際にはプロジェクト外への書き込みまで
  // 到達し得るということ)。
  //
  // 訂正 (2026-08-16 デルタレビューでの指摘): 当初「BDBOARD_CHAT_AGENTS opt-in +
  // isLocalControlRequest ゲート(トンネル経由では選択・実行不可)」と書いていたが誤り。
  // chat-agent-gate.ts は「トンネル経由かどうかによる到達可否」を意図的に実装していない
  // (bdboard-9a9 の裁定でチャットへの read/write 権限付与そのものが認められたため)。
  // POST /api/chat/message にエージェントの capability を見て経路を絞るローカル限定判定は
  // 無く、chat-routes.test.ts の
  // 'allows a non-bd-only capability agent to be selected and used through the tunnel'
  // が、unrestricted capability の codex アダプタをトンネル経由でも選択・実行できることを
  // 固定テストとして保証している。実際に効いているのは他の書き込み系エンドポイントと同じ
  // 認可 (createPrivilegedApiGuardMiddleware による CSRF チェック + 強トンネルパスワード +
  // セッション Cookie) であって、opt-in 後はそれさえ満たせばトンネル越しにも到達可能。
  // つまり bdboard 側の防御線は「opt-in するかどうか(既定オフ)」と「トンネル自体を有効化し
  // 強パスワードで守るかどうか」の二点のみで、opt-in 後の到達範囲をローカル限定にする仕組みは
  // 存在しない。将来 codex-cli 側に「MCP 承認とサンドボックスエスカレーション承認を分離する」
  // フラグが追加されたら、この既知リスク自体を見直すこと。
  return ['exec', ...sharedFlags, '--approve-for-me'];
}

export function createCodexSpec(options: CodexSpecOptions): CliChatAgentSpec {
  return {
    // capability は正直に 'unrestricted'。claude-chat-agent の bd-only な安全性は
    // --tools '' + --strict-mcp-config + --allowedTools mcp__bd__* という Claude Code
    // 固有機能で作られており、codex-cli 0.147.0 にはこれと等価な「組み込みツールを
    // 全部外して MCP だけ残す」機能が無い(2026-08-16 --help で実測確認済み)。
    // つまり codex アダプタは実際に shell/ファイル読み書きが可能であり、それを
    // 'bd-only' と偽って capability に出すと bd-system-prompt や UI 側の警告表示
    // (bdboard-l1t.4 で capability-aware 化した箇所)が全部嘘をつくことになる。
    // この権限の広さ自体は bdboard-9a9 の裁定で許容された設計判断であり、
    // 既定で有効化されないことは BDBOARD_CHAT_AGENTS opt-in ゲート(main.ts /
    // chat-agent-gate.ts)側で担保する。
    // weight: 1 の明示宣言(bdboard-3tw.104.11 Opus レビュー SF1): codex は claude と違い
    // モデル別の重み知識を持たない(2026-08-16 時点 gpt-5.x 系のみ opt-in 運用、課金は OpenAI
    // 側の別枠)。cursor/agy と同じく、宣言を省いて default フォールバックに暗黙に頼るのではなく、
    // 「子プロセス起動 1 回 = 1」という既定を自分で明示しておく(3 spec の一貫性)。
    descriptor: {
      id: 'codex',
      label: 'Codex CLI',
      ...(options.model !== ''
        ? { model: options.model, models: [{ id: options.model, label: options.model, weight: 1 }] }
        : {}),
      experimental: true,
      capability: 'unrestricted',
      supportsImages: true,
    },
    binaryPath: options.codexPath,
    envAllowlist: CODEX_ENV_ALLOWLIST,
    versionArgs: ['--version'],
    authProbe: {
      // 2026-09-05 実測 (codex-cli 0.153.2): `codex login status` は stdout ではなく stderr
      // に結果を書く。ログイン済みは exit 0 + stderr `Logged in using ChatGPT`、未ログインは
      // exit 1 + stderr `Not logged in` — どちらも stdout は空。判定は stdout/stderr を連結して
      // 行う (agy-spec.ts の authProbe と同型)。また `'not logged in'` は `'logged in'` を部分文字列
      // として含むため、否定形を先に評価しないと未ログインが available と誤判定される。
      args: ['login', 'status'],
      interpret(result: CommandResult): ChatAgentAvailability {
        if (result.failureKind === 'timeout') return 'unknown';
        const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
        if (text.includes('not logged in') || text.includes('logged out') || text.includes('no credentials')) return 'unavailable';
        if (text.includes('logged in')) return 'available';
        return 'unknown';
      },
    },
    timeoutMs: options.timeoutMs,
    buildTurn(request, ctx): CliTurnPlan {
      const images = request.images ?? [];
      const imagePaths = buildImagePaths(images, ctx.scratchDir);
      // 応答ファイル (codex の -o / --output-last-message) の秘匿性について (bdboard-jp3)。
      //
      // 応答本文を書き出すのは codex CLI の子プロセスなので、こちら側から mode を指定できない。
      // 子プロセスの umask 任せになり、POSIX では典型的に 0644 (ワールド可読) になる。
      //
      // 先に 0600 の空ファイルを作って CLI に渡す案は採らない。現行の codex
      // (codex-rs/exec/src/event_processor.rs の write_last_message_file) は `std::fs::write` で
      // create+truncate するだけなので、この案でも「今は」mode が保たれる — つまり検証は可能で、
      // 実際に確認もした。採らないのは版をまたいだ保証にならないから: tempfile+rename 型の
      // アトミック書き込みに変わった時点で、こちらのコードは何も言わずに秘匿性を失う。
      //
      // 代わりに置き場所に依拠する: `mkdtempSync` が作る 0700 ディレクトリの中に置けば、POSIX では
      // 他ユーザーがディレクトリを traverse できないので、CLI が中のファイルを何 mode で作ろうと
      // 秘匿性は保たれる (mkdtemp の mode は 0700 & ~umask。umask はビットを減らす方向にしか
      // 効かないので、group/other が付くことは無条件にあり得ない)。Windows では mkdtemp が親
      // (`%TEMP%`) の ACL を継承するので、画像一時ファイルと同じ「ユーザープロファイル配下の Temp の既定 ACL に依拠する」前提がそのまま乗る
      // (コードが ACL を強制する保証ではなく環境への前提である点も同じ。根拠は writeImageFiles の
      // コメントを参照)。
      //
      // lastMessageFile のパスは argv 構築に必要なので、TOML/MCP バリデーションより前にこの
      // ディレクトリを作る。buildCodexArgs / writeImageFiles が throw したときは
      // createCliChatAgent の finally へ届かないため、ここで必ず片付けてから再throwする。
      const turnDir = mkdtempSync(path.join(ctx.scratchDir, 'bdboard-codex-turn-'));
      const lastMessageFile = path.join(turnDir, 'last-message.txt');
      let args: readonly string[];
      try {
        // TOML/MCP validation can throw. Build argv before creating any image artifact so
        // that a validation failure cannot leak a temporary file.
        args = buildCodexArgs(
          request,
          ctx,
          request.model ?? options.model,
          lastMessageFile,
          imagePaths,
        );
        writeImageFiles(images, imagePaths);
      } catch (err) {
        try {
          // force: true が「存在しない」を握り潰すので ENOENT の判定は要らない。
          rmSync(turnDir, { recursive: true, force: true });
        } catch {
          console.error('chat codex-spec: failed to remove a partial turn artifact directory');
        }
        throw err;
      }
      return {
        args,
        stdin: buildCodexStdin(ctx, request.message),
        lastMessageFile,
        temporaryDirs: [turnDir],
        ...(imagePaths.length > 0 ? { temporaryFiles: imagePaths } : {}),
      };
    },
    parseTurn(result: CommandResult, readLastMessageFile: () => string | undefined): Omit<ChatTurnResult, 'agentId'> {
      const { threadId, failedTools } = parseCodexEvents(result.stdout);
      if (threadId === undefined) throw new ChatAgentError('agent-unexpected-output');
      const reply = readLastMessageFile();
      if (reply === undefined) throw new ChatAgentError('agent-bad-output');
      return { reply, sessionId: threadId, failedTools };
    },
  };
}
