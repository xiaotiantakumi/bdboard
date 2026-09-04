import { z } from 'zod';
import { ChatAgentError, type ChatAgentAvailability, type ChatFailureCode, type ChatTurnRequest, type ChatTurnResult } from '../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../application/ports/command-runner.js';
import type { CliChatAgentSpec, CliTurnContext, CliTurnPlan } from '../cli-chat-agent.js';

// cursor-agent には CODEX_HOME 相当の「認証/セッションの保存場所を指すための
// 環境変数」が見つからなかった(2026-08-16、cursor-agent 2026.08.11-e8db854 の
// バンドル済み index.js を grep して "CURSOR_" 環境変数を全て洗い出したが、
// 設定ディレクトリを差し替えるものは無い)。`cursor-agent login` 済みの認証情報は
// 常に $HOME/.cursor 配下から読まれるため、HOME を allowlist に含めれば足りる。
//
// 意図的に allowlist へ入れていないもの(bdboard-l1t.5 Opus レビュー nit):
// CURSOR_API_KEY / CURSOR_API_ENDPOINT。cursor-agent の index.js にはこれらの
// 環境変数で API キー認証する経路が存在する(grep で確認済み)が、bdboard は
// シークレット値をプロセス環境へ流し込む経路を持たない設計方針
// (CLAUDE.md「シークレット値を表示しない」/ kv_inject 経由の明示注入のみ)なので、
// この2つは allowlist に加えない。結果として cursor アダプタは API キー認証を
// サポートせず、運用者が事前に対話で `cursor-agent login` を済ませておくことが
// 前提になる(authProbe の `status --format json` はこのログイン状態を見る)。
export const CURSOR_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ'] as const;

// bdboard-l1t.5 Opus レビュー SF1: cursor-agent が対象ディレクトリを未信頼と
// 判断したときに固定で吐く stderr マーカー(2026-08-16、使い捨て mktemp -d
// ディレクトリで `bd init` 済みプロジェクトを作り、事前の trust 操作なしで
// `cursor-agent --print` を実行して実測)。exit code 1、stdout は空、stderr に
// このメッセージが出る。ここでは固定文字列の部分一致のみを見て、生の stderr は
// 一切クライアントへ返さない(bdboard-pvl)。
//
// bdboard-l1t.5 Opus レビュー nit: このディレクトリを対話なしで信頼済み扱いにする
// フラグは、chat-specs-are-safe.test.ts の FORBIDDEN_CHAT_TOKENS に載っている
// 禁止トークンのひとつであり(README にも同じ制約を明記済み)、bdboard のコード
// パスからは絶対に渡さない。そのため cursor アダプタは、運用者が事前に対話で
// (または当該フラグを使い捨てディレクトリ限定の受け入れテストでのみ手動実行して)
// プロジェクトディレクトリを信頼済みにしていない限り、このエラー分類が常に
// 発生しうる — README の cursor セクションにその前提を明記すること(SF2)。
const WORKSPACE_TRUST_REQUIRED_MARKER = 'Workspace Trust Required';

export interface CursorSpecOptions {
  readonly cursorPath: string;
  readonly model: string;
  readonly timeoutMs: number;
}

// `cursor-agent --print --output-format json` の最終出力(2026-08-16 実測)。
// stream-json ではなく単発の JSON オブジェクトを stdout に1行だけ書く点が
// codex(JSONL の event 列)と異なり、claude の `-p --output-format json` に近い。
// 例:
// {"type":"result","subtype":"success","is_error":false,"duration_ms":...,
//  "result":"...","session_id":"...","request_id":"...","usage":{...}}
const cursorResultSchema = z
  .object({
    type: z.literal('result'),
    is_error: z.boolean().optional(),
    result: z.string(),
    session_id: z.string(),
  })
  .passthrough();

type CursorResult = z.infer<typeof cursorResultSchema>;

/** JSON.parse を試し、成功かつ schema 検証も通れば結果を返す。それ以外は undefined。 */
function tryParseAsCursorResult(candidate: string): CursorResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  const validated = cursorResultSchema.safeParse(parsed);
  return validated.success ? validated.data : undefined;
}

/**
 * bdboard-l1t.5 Opus レビュー SF5(+ 再レビュー DF5): `--output-format json` は
 * 仕様上 stdout に単一の JSON オブジェクトだけを書く想定だが、万一 CLI 側の
 * 診断出力などが stdout に混じって単純な `JSON.parse(result.stdout)` が失敗した
 * 場合に備え、2段のフォールバックを試す:
 *   1. 行単位に割って末尾から順に schema 検証が通る最後の JSON オブジェクトを探す
 *      (診断出力が改行区切りで前置/後置されているケースを想定)。
 *   2. それでも見つからなければ、stdout 全体から最初の `{` と最後の `}` の
 *      区間を1個の候補として切り出して試す(pretty-print された複数行 JSON の
 *      前後にノイズが乗っているなど、行単位では復元できない構造のケースを
 *      カバーする)。
 * どちらも失敗すれば 'agent-bad-output' に倒す(型が合わない JSON が見つかった
 * 場合は 'agent-unexpected-output')。
 */
function parseCursorResult(stdout: string): CursorResult {
  const wholeStdout = tryParseAsCursorResult(stdout);
  if (wholeStdout !== undefined) {
    return wholeStdout;
  }
  // 全体が有効な JSON で、かつ schema にマッチしなかった場合(=JSON.parse 自体は
  // 成功したが shape が違う)は、フォールバックへ進まず shape エラーとして扱う。
  // フォールバックは「JSON.parse 自体が失敗した」場合専用。
  try {
    JSON.parse(stdout);
    // ここに到達するのは「JSON としては valid だが schema と合わない」場合のみ。
    throw new ChatAgentError('agent-unexpected-output');
  } catch (err) {
    if (err instanceof ChatAgentError) {
      throw err;
    }
    // JSON.parse(stdout) 自体が失敗した場合だけ、ここから下のフォールバックへ進む。
  }

  // フォールバック1: 行単位に割って末尾から順に探す。
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === '') {
      continue;
    }
    const fromLine = tryParseAsCursorResult(line);
    if (fromLine !== undefined) {
      return fromLine;
    }
  }

  // フォールバック2(DF5): 最初の `{` から最後の `}` までを1個の候補として試す。
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = stdout.slice(firstBrace, lastBrace + 1);
    const fromSlice = tryParseAsCursorResult(sliced);
    if (fromSlice !== undefined) {
      return fromSlice;
    }
  }

  throw new ChatAgentError('agent-bad-output');
}

// `cursor-agent status --format json` の実測出力(認証済み):
// {"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,
//  "hasRefreshToken":true,"userInfo":{...}}
// 未認証時の実測出力 (2026-09-05, bdboard-6ids。HOME を空の一時ディレクトリに向けて再現。
// `cursor-agent logout` は運用者の実セッションを破壊するので使っていない):
// {"status":"unauthenticated","isAuthenticated":false,"hasAccessToken":false,
//  "hasRefreshToken":false,"message":"Not logged in"}
// 未認証でも exitCode は 0 なので、終了コードで認証状態を判定してはいけない。
// schema にマッチしない場合は 'unknown' に倒す。
const cursorStatusSchema = z
  .object({
    isAuthenticated: z.boolean(),
  })
  .passthrough();

// codex 同様、cursor-agent にもシステムプロンプト専用の引数が無い(2026-08-16
// `cursor-agent --help` / `cursor-agent -p --help` を実測。オプション一覧に
// system-prompt 相当は存在しない)。そのため、ターンごとに実メッセージの前へ
// systemPrompt を連結して stdin から渡す(codex-spec.ts の buildCodexStdin と同型)。
function buildCursorStdin(ctx: CliTurnContext, message: string): string {
  return `${ctx.systemPrompt}\n\n---\n\n${message}`;
}

function buildCursorArgs(request: ChatTurnRequest, model: string): string[] {
  // --print (-p) は --help に明記されているとおり write/shell を含む全ツールへ
  // アクセスできるモードで、これが descriptor.capability を 'unrestricted' に
  // している根拠そのもの(2026-08-16 実測)。--mode ask/plan のような読み取り専用
  // モードは意図的に使わない(それだと claude と同じ 'bd-only' 相当の安全性を
  // 偽って 'unrestricted' と申告することになってしまう)。
  //
  // bdboard-l1t.5 Opus レビュー MF1・SF3(受け入れテスト実測、2026-08-16、
  // 使い捨て mktemp -d ディレクトリで実施、終了後にディレクトリは削除済み):
  // --sandbox enabled は --help の choices に enabled/disabled があることを確認済みの
  // 制限方向のフラグで、FORBIDDEN_CHAT_TOKENS には該当しない。これを渡さない場合、
  // 運用者の実際の ~/.cursor/cli-config.json (approvalMode: allowlist、
  // permissions.allow に Shell(ls) のみ登録)の下では、シェルツール呼び出し
  // (`bd ready` 等)は非対話実行時にサイレントに拒否され、bd 運用がそもそも
  // 一切できない(「bd capability zero」)ことを確認した。--sandbox enabled を
  // 付けると、サンドボックス化されたシェル実行が approvalMode の設定に関わらず
  // 自動承認されるらしく、同じ `bd ready` 呼び出しが実際に成功することを確認した
  // (stdout に bd ready の結果 JSON が含まれた最終応答が返った)。そのため
  // --sandbox enabled を常に付与し、bd システムプロンプト(bd-system-prompt.ts)の
  // 「シェル経由で bd を直接呼べ」という案内が実際に機能する状態にする。
  //
  // --sandbox enabled の書き込み封じ込め範囲について(bdboard-l1t.5 Opus 再レビュー
  // DF2、2026-08-16 再実測): 当初「/tmp への書き込みが成功した」ことから
  // 「プロジェクト配下に閉じ込めない」と結論していたが、これは計測アーティファクト
  // だった可能性が高いとレビューで指摘された(cursorsandbox バイナリの seatbelt
  // プロファイルを strings で復元すると、read は全域 allow・write は
  // WRITABLE_ROOT_N のサブパスのみ allow で、/tmp や /var/folders はその
  // writable root の一つとして特別扱いされている可能性がある)。そこで
  // ワークスペース外・かつ temp 系でもないパス(`$HOME/bdboard-sandbox-probe.txt`)
  // への書き込みを使い捨てディレクトリから指示して再実測したところ、
  // シェルコマンドが `operation not permitted` で拒否され、モデルがサンドボックス外
  // (unsandboxed)での再実行を要求したがその昇格も承認されず、実際に
  // $HOME にファイルは作成されなかったことを確認した(実測後、書き込みは
  // 一度も成功していないため後始末の削除も不要だった)。
  //
  // 結論: --sandbox enabled は書き込みをワークスペース(+ /tmp・/var/folders 等の
  // temp 系ディレクトリ)に封じ込めており、temp 系以外の任意パス(例: $HOME 直下)
  // への書き込みはブロックされる。以前の「プロジェクト配下に閉じ込めない」という
  // 記述は誤りだった(bdboard-l1t.5 最終レビュー FF1)。bd-system-prompt.ts の
  // プロンプト文面も、この結論と「bdboard が --sandbox enabled を無条件で渡して
  // いる(＝制限を課しているのは運用者ではなく bdboard 自身)」という事実に合わせて
  // 書き直し済み(詳細は bd-system-prompt.ts の該当コメントを参照)。
  const args = ['--print', '--output-format', 'json', '--sandbox', 'enabled'];
  if (model !== '') {
    args.push('--model', model);
  }
  if (request.resumeSessionId !== undefined) {
    // --resume <chatId> は codex の `exec resume <id>` と違いサブコマンドではなく
    // 通常のフラグで、新規ターンと同じ引数構成に足すだけでよい(2026-08-16 実測:
    // 同一ディレクトリで新規ターンの session_id を控え、別プロセスから
    // --resume <その id> で追いメッセージを送ったところ、直前の会話内容を
    // 踏まえた返答が返ってくることを確認済み)。存在しない/でたらめな id を
    // 渡してもエラーにはならず、その id をそのまま session_id として返しつつ
    // 新規セッションとして応答する(サイレントフォールバック)。bdboard 側は
    // request.resumeSessionId をそのまま渡すだけで、id の実在検証はしない。
    args.push('--resume', request.resumeSessionId);
  }
  return args;
}

export function createCursorSpec(options: CursorSpecOptions): CliChatAgentSpec {
  return {
    // capability は codex と同じ 'unrestricted' 系。ただし codex と違い、cursor
    // アダプタには bd MCP ツールが一切接続されていない(下記 mcpServers 非対応の
    // 理由を参照)。「bd ツール + shell/file 両方」の codex に対し、cursor は
    // 「shell/file のみ(bd ツール無し)」という非対称な構成になる。この差は
    // capability の値では表現しきれないため、bd-system-prompt.ts 側に
    // hasBdTools: false を渡し、システムプロンプトの文面で正直に伝える
    // (buildBdSystemPrompt の呼び出し元は cursor-chat-agent.ts)。
    descriptor: {
      id: 'cursor',
      label: 'Cursor Agent CLI',
      // weight: 1 の明示宣言(bdboard-3tw.104.11 Opus レビュー SF2): cursor-agent の課金は
      // bdboard のトンネルレート制限とは別枠の Cursor 側サブスク/API 従量で発生する。ここで
      // 数えているのは「トンネル経由で子プロセスを何回起動させるか」という bdboard 自身の
      // リソース上限であって、Cursor 側のモデル別コスト差を反映する必要は無い。そのため
      // 宣言なし(→ default フォールバック)に暗黙に頼るのではなく、「子プロセス起動 1 回 = 1」を
      // 意図的な既定として自分で明示しておく。
      ...(options.model !== '' ? { model: options.model, models: [{ id: options.model, label: options.model, weight: 1 }] } : {}),
      experimental: true,
      capability: 'unrestricted',
    },
    binaryPath: options.cursorPath,
    envAllowlist: CURSOR_ENV_ALLOWLIST,
    versionArgs: ['--version'],
    authProbe: {
      args: ['status', '--format', 'json'],
      interpret(result: CommandResult): ChatAgentAvailability {
        if (result.failureKind === 'timeout') return 'unknown';
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          return 'unknown';
        }
        const validated = cursorStatusSchema.safeParse(parsed);
        if (!validated.success) return 'unknown';
        return validated.data.isAuthenticated ? 'available' : 'unavailable';
      },
    },
    timeoutMs: options.timeoutMs,
    // bdboard-l1t.5 Opus レビュー SF1(+ 再レビュー DF3): 固定の
    // "Workspace Trust Required" マーカーが stderr に含まれる場合だけ
    // 'agent-workspace-untrusted' として分類する。それ以外は undefined を返して
    // cli-chat-agent.ts 側の classifyCommandFailure フォールバックに委ねる。
    // stderr の生テキストはここでも一切返り値に含めない(判定にだけ使う)。
    //
    // DF3: result.failureKind が立っている(spawn-failed / timeout)場合は、
    // プロセスがそもそも正常起動できていない/応答が返らなかったケースであり、
    // stderr の内容(たまたま "Workspace Trust Required" という文字列を含む
    // 無関係な出力が残っていた場合など)より agent-not-found / agent-timeout の
    // 分類を優先すべき。ここで早期 return して cli-chat-agent.ts 側の
    // classifyCommandFailure(failureKind 起点の分類)に確実に委ねる。
    classifyFailure(result: CommandResult): ChatFailureCode | undefined {
      if (result.failureKind !== undefined) {
        return undefined;
      }
      if (result.stderr.includes(WORKSPACE_TRUST_REQUIRED_MARKER)) {
        return 'agent-workspace-untrusted';
      }
      return undefined;
    },
    buildTurn(request, ctx): CliTurnPlan {
      // ctx.mcpServers / ctx.toolNames は意図的に無視する。cursor-agent CLI には
      // codex の `-c mcp_servers.<name>.command=...` や claude の
      // `--mcp-config <json>` に相当する「ターン単位で MCP サーバーを注入する」
      // 引数が無い(2026-08-16 実測: `cursor-agent --help` のオプション一覧に
      // mcp 関連フラグは無く、`cursor-agent mcp` サブコマンドは
      // login/list/list-tools/enable/disable のみで、コマンド1回分の設定を
      // 渡す add 相当のサブコマンドも存在しない。MCP サーバーは
      // `.cursor/mcp.json`(プロジェクト or $HOME 配下)に永続的に書いた上で
      // `cursor-agent mcp enable <identifier>` によるローカル承認リストへの
      // 追加が必要な設計で、これは「ターンごとに使い捨てる」bdboard の
      // MCP 注入モデルと根本的に合わない)。加えて、その承認を非対話で
      // 自動化する唯一の手段と見られる approve-mcps 系フラグは
      // chat-specs-are-safe.test.ts の FORBIDDEN_CHAT_TOKENS で禁止されている。
      // そのため cursor アダプタは bd MCP ツール無しの素のチャットとして実装する
      // (要件どおり)。
      return {
        args: buildCursorArgs(request, request.model ?? options.model),
        stdin: buildCursorStdin(ctx, request.message),
      };
    },
    parseTurn(result: CommandResult, _readLastMessageFile: () => string | undefined): Omit<ChatTurnResult, 'agentId'> {
      const validated = parseCursorResult(result.stdout);
      // bdboard-l1t.5 Opus レビュー SF4(+ 再レビュー DF6): cursor-agent 自身が
      // is_error: true を報告するケース(内部でエラーが起きたがプロセス自体は
      // exit 0 で終わる場合)を「正常応答」として扱わない。result 文字列に
      // エラー内容が入っていたとしても、生の中身をそのままクライアントへ流すの
      // ではなく定型の失敗コードへ倒す(bdboard-pvl: detail は常に
      // CHAT_FAILURE_MESSAGES 由来の定型文のみ)。JSON の shape 自体は
      // schema どおり正常(session_id/result とも揃っている)なので、shape 異常を
      // 意味する 'agent-unexpected-output' ではなく専用の 'agent-reported-error'
      // を使う(誤って「CLI の出力形式が壊れた」と読めるメッセージを出さないため)。
      if (validated.is_error === true) {
        throw new ChatAgentError('agent-reported-error');
      }
      // bd MCP ツールを一切繋いでいないため、失敗しうるツール呼び出し自体が
      // 存在しない。failedTools は常に空(codex/claude と違い、ここに値が入ることはない)。
      return { reply: validated.result, sessionId: validated.session_id, failedTools: [] };
    },
  };
}
