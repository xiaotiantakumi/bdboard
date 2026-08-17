import { z } from 'zod';
import { ChatAgentError, type ChatAgentAvailability, type ChatFailureCode, type ChatTurnRequest, type ChatTurnResult } from '../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../application/ports/command-runner.js';
import type { CliChatAgentSpec, CliTurnContext, CliTurnPlan } from '../cli-chat-agent.js';

// agy (Antigravity CLI) は設定・認証を $HOME/.gemini 配下から読む。設定ディレクトリを
// 差し替える環境変数は見つかっていない(2026-08-16、agy 1.1.13 のバイナリ strings から
// 候補に見えた JETSKI_APP_DATA_DIR を実測したが、CLI 本体には無視された)。そのため
// cursor と同様、HOME を allowlist に含めれば足りる。API キーを環境変数で流し込む経路は
// 方針どおり持たない(CLAUDE.md「シークレット値を表示しない」/ kv_inject 経由の明示注入のみ。
// cursor-spec.ts の CURSOR_ENV_ALLOWLIST コメントと同じ判断)。運用者が事前に対話で
// agy にサインイン(OAuth)済みであることが前提になる。
export const AGY_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ'] as const;

// agy の headless (--print) モードは、承認が必要なツール呼び出し(run_command による
// シェル実行、read_file によるファイル読み取りなど)を既定ですべて自動拒否する
// (2026-08-16 実測: サーバーログに "Print mode: soft-denying tool confirmation" が出て、
// プロセスは exit 0・stdout は status SUCCESS + 空 response のまま、stderr に
// 「... required the "command" permission that headless mode cannot prompt for, so it was
// auto-denied. ...」という固定メッセージを書く)。
//
// 重要(Opus レビュー MF1): このマーカーは「ツール呼び出し1件を soft-deny した」という
// ツール単位の通知であって「ターン全体が失敗した」という宣言ではない。agy 1.1.13 の
// バイナリには recordHeadlessSoftDeny / HeadlessSoftDeniedTools /
// printmode.headlessDenialNotice というシンボルがあり、拒否を蓄積してターン継続する
// 実装を示唆する。実測(2026-08-16、4回試行)ではいずれも最初の拒否でターンが終わり
// response は空だったが、「マーカー有り + 非空 response」の混在形が出ないことの保証は
// 無い。そのため parseTurn ではマーカーを即エラーにせず、先に stdout をパースし、
// response が空のときだけ 'agent-headless-denied' に分類する(非空ならログのみ出して
// 返信を返す)。生の stderr はクライアントへ返さない(bdboard-pvl)。拒否を解除する
// 唯一の非危険な手段は、運用者が bdboard の外で
// ~/.gemini/antigravity-cli/settings.json の permissions.allow に command(bd) 等の
// 許可ルールを足すことで、これが headless にも効くことを実測で確認済み(README の
// agy 節を参照)。全ツールを自動承認する危険フラグは方針どおり使わない。
const HEADLESS_AUTO_DENY_MARKER = 'headless mode cannot prompt';

// agy 内部の --print-timeout(既定 5m)と CliChatAgentSpec.timeoutMs(CommandRunner の
// プロセス kill)のどちらが先に発火するかを固定するための余白。--print-timeout には
// 常に timeoutMs + この余白を渡すので、bdboard 側の timeoutMs が必ず先に発火し、
// 失敗は一律 classifyCommandFailure の 'agent-timeout' として分類される
// (bdboard-l1t.6 AC: タイムアウトの先後関係を明示的に固定する)。
const PRINT_TIMEOUT_MARGIN_MS = 60_000;

// Opus レビュー SF4: BDBOARD_CHAT_TIMEOUT_MS に 0 や負値が設定されると、CommandRunner
// 側の kill が「即時 or 無効」になり、上の「bdboard 側 timeoutMs が必ず先に発火する」
// という先後関係が崩れる(--print-timeout 側が先に発火し得る)。ここで正の最小値に
// クランプして、余白計算の前提(timeoutMs > 0)を spec 内で自己完結に保証する。
const MIN_TIMEOUT_MS = 1_000;

export interface AgySpecOptions {
  readonly agyPath: string;
  readonly model: string;
  readonly timeoutMs: number;
}

// `agy --print=... --output-format json` の最終出力(2026-08-16 実測)。cursor と同様、
// stdout に単発の JSON オブジェクトを1行で書く。例:
// {"conversation_id":"d876c288-12df-4038-bcf2-21b9fbd1ade5","status":"SUCCESS",
//  "response":"PONG\n","duration_seconds":1.97,"num_turns":1,"usage":{...}}
// conversation_id は UUID で、S2 の isValidChatSessionId を通る(agy-spec.test.ts で固定)。
const agyResultSchema = z.object({ conversation_id: z.string(), status: z.string(), response: z.string() }).passthrough();
type AgyResult = z.infer<typeof agyResultSchema>;

function tryParseAsAgyResult(candidate: string): AgyResult | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { return undefined; }
  const validated = agyResultSchema.safeParse(parsed);
  return validated.success ? validated.data : undefined;
}

/**
 * stdout から結果 JSON を復元する。cursor-spec.ts の parseCursorResult
 * (bdboard-l1t.5 Opus レビュー SF5 + 再レビュー DF5)と同じ 3 段構え:
 *   0. stdout 全体をそのまま JSON として試す。JSON としては valid だが shape が
 *      違う場合はフォールバックせず 'agent-unexpected-output' に倒す。
 *   1. 行単位に割って末尾から順に schema 検証が通る JSON を探す。
 *   2. 最初の `{` から最後の `}` までを1候補として試す(pretty-print 対応)。
 * どれも失敗すれば 'agent-bad-output'。
 */
function parseAgyResult(stdout: string): AgyResult {
  const whole = tryParseAsAgyResult(stdout);
  if (whole !== undefined) return whole;
  try {
    JSON.parse(stdout);
    // ここに到達するのは「JSON としては valid だが schema と合わない」場合のみ。
    throw new ChatAgentError('agent-unexpected-output');
  } catch (err) {
    if (err instanceof ChatAgentError) throw err;
    // JSON.parse(stdout) 自体が失敗した場合だけ、フォールバックへ進む。
  }
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === '') continue;
    const parsed = tryParseAsAgyResult(line);
    if (parsed !== undefined) return parsed;
  }
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParseAsAgyResult(stdout.slice(firstBrace, lastBrace + 1));
    if (parsed !== undefined) return parsed;
  }
  throw new ChatAgentError('agent-bad-output');
}

export function createAgySpec(options: AgySpecOptions): CliChatAgentSpec {
  const timeoutMs = Math.max(options.timeoutMs, MIN_TIMEOUT_MS);
  return {
    // capability は 'unrestricted' の正直な申告(bdboard-l1t.6)。agy が実際に到達できる
    // ツール面は運用者側の permissions.allow 設定(グローバル設定)に依存し、bdboard は
    // それを書き換えも検証もできない。狭い宣言(例: 'bd-only')をすると、運用者が広い
    // 許可ルールを持っていた場合に嘘になるため、最悪ケースで申告する。
    // cursor と同様、bd MCP ツールは一切接続されない(hasBdTools: false 構成)ことは
    // capability の値では表現できず、bd-system-prompt.ts 側の文面で正直に伝える
    // (配線は agy-chat-agent.ts)。
    descriptor: {
      id: 'agy',
      label: 'Antigravity CLI',
      // weight: 1 の明示宣言(bdboard-3tw.104.11 Opus レビュー SF2): agy の課金は bdboard の
      // トンネルレート制限とは別枠の Google (Antigravity) 側サブスクで発生する。ここで数えて
      // いるのは「トンネル経由で子プロセスを何回起動させるか」という bdboard 自身のリソース
      // 上限であって、Google 側のモデル別コスト差を反映する必要は無い。そのため宣言なし
      // (→ default フォールバック)に暗黙に頼るのではなく、「子プロセス起動 1 回 = 1」を
      // 意図的な既定として自分で明示しておく。
      ...(options.model !== '' ? { model: options.model, models: [{ id: options.model, label: options.model, weight: 1 }] } : {}),
      experimental: true,
      capability: 'unrestricted',
    },
    binaryPath: options.agyPath,
    envAllowlist: AGY_ENV_ALLOWLIST,
    versionArgs: ['--version'],
    authProbe: {
      // `agy models` は利用可能モデル一覧のメタデータ取得で、モデル呼び出し(課金)は
      // 発生しない(bdboard-15v)。2026-08-16 実測: 認証済みだと exit 0 で stdout に
      // タブ区切りの一覧(1〜2秒)、未認証だと exit 1 で stderr に
      // "Error: Please sign in to view available models. ..." を書く。
      args: ['models'],
      interpret(result: CommandResult): ChatAgentAvailability {
        if (result.failureKind === 'timeout') return 'unknown';
        if (result.exitCode === 0) return 'available';
        return `${result.stdout}\n${result.stderr}`.toLowerCase().includes('sign in') ? 'unavailable' : 'unknown';
      },
    },
    timeoutMs,
    // Opus レビュー SF3: exit code 非 0 の失敗経路でも、stderr に headless 自動拒否の
    // マーカーが出ていれば汎用の 'agent-error' より具体的な 'agent-headless-denied' を
    // 返す(cursor-spec.ts の classifyFailure と同型)。実測済みの拒否は exit 0 なので
    // 通常は parseTurn 側で分類されるが、将来 agy が拒否時に非 0 で終了するように
    // 変わっても分類が保たれるようにする防御。failureKind が立っている
    // (spawn-failed / timeout)場合は、無関係な stderr 残骸より agent-not-found /
    // agent-timeout の分類を優先すべきなので早期 return で委ねる。
    classifyFailure(result: CommandResult): ChatFailureCode | undefined {
      if (result.failureKind !== undefined) {
        return undefined;
      }
      if (result.stderr.includes(HEADLESS_AUTO_DENY_MARKER)) {
        return 'agent-headless-denied';
      }
      return undefined;
    },
    buildTurn(request: ChatTurnRequest, ctx: CliTurnContext): CliTurnPlan {
      // ctx.mcpServers / ctx.toolNames は意図的に無視する(cursor-spec.ts と同じ判断)。
      // agy 1.1.13 にはターン単位で MCP サーバーを注入する引数が無く(2026-08-16 実測:
      // `agy --help` に mcp 関連フラグは無い)、MCP は設定ファイル経由のみ
      // (グローバル ~/.gemini/config/mcp_config.json、またはプラグイン内)。ワークスペース
      // スコープの `.agents/plugins/<name>/mcp_config.json` / `.agents/hooks.json` も
      // CLI は読み込まない(実測: git repo 化した使い捨てディレクトリに置いても
      // hooks manager が "loaded 0 named hooks from 0 hooks.json file(s)" のまま)。
      // そのため bd MCP ツール無しの素のチャットとして実装する。
      //
      // プロンプトは `--print=<text>` の1トークンで渡す。agy は stdin からプロンプトを
      // 読まず(2026-08-16 実測: パイプで渡すと -p が後続フラグを値として食う誤解釈になる)、
      // `--print=` 形式なら先頭が `-` のテキストもフラグと誤解釈されないことを実測済み。
      // システムプロンプト専用の引数も無いため、codex/cursor の stdin 前置と同型で
      // 実メッセージの前に連結する。
      //
      // `--sandbox` フラグは意図的に渡さない(Opus レビュー SF5、2026-08-16 実測):
      // --sandbox を付けても headless の自動拒否は解除されず、さらに sandbox 下では
      // 許可済みの bd コマンド自体が壊れる(Dolt が $HOME/.dolt/config_global.json を
      // open しようとして operation not permitted → "failed to open database"。同一設定で
      // sandbox 無しなら同じ bd コマンドが成功することを対照実験で確認済み)。
      const printTimeout = `${timeoutMs + PRINT_TIMEOUT_MARGIN_MS}ms`;
      const model = request.model ?? options.model;
      const args = [`--print=${ctx.systemPrompt}\n\n---\n\n${request.message}`, '--output-format', 'json', '--print-timeout', printTimeout];
      if (model !== '') args.push('--model', model);
      if (request.resumeSessionId !== undefined) {
        // `--conversation <id>` は通常のフラグで、新規ターンと同じ引数構成に足すだけでよい
        // (2026-08-16 実測: 新規ターンの conversation_id を控え、別プロセスから
        // --conversation <その id> で追いメッセージを送ると、同じ conversation_id と
        // インクリメントされた num_turns が返り、直前の会話内容を踏まえた返答になる)。
        // 存在しない id を渡した場合の挙動も実測済み(Opus レビュー SF7、2026-08-16):
        // hard error にはならず exit 0 のまま、stderr に
        // `warning: conversation "<id>" not found` を書き、サーバーログに "ignoring
        // --conversation flag" を残して新規会話としてフォールバックし、新しい
        // conversation_id を返す(サイレントフォールバック)。cursor の --resume と
        // 同じ挙動なので専用の失敗分類は足さず、id 不一致を cli-chat-agent.ts が
        // 警告ログに出す既存の仕組みで足りる。bdboard 側は id の実在検証をしない。
        args.push('--conversation', request.resumeSessionId);
      }
      return { args };
    },
    parseTurn(result: CommandResult, _readLastMessageFile: () => string | undefined): Omit<ChatTurnResult, 'agentId'> {
      // Opus レビュー MF1: stderr の自動拒否マーカーはツール単位の soft-denial 通知で
      // あって、ターンが成功しなかったことの証明ではない(マーカーの定義コメント参照)。
      // 先にマーカーで即エラーにすると「途中で1件拒否されたがモデルは最終応答を
      // 返せた」ターンを捨ててしまうため、必ず先に stdout をパースし、response が
      // 空のときだけ denial として分類する。
      const denied = result.stderr.includes(HEADLESS_AUTO_DENY_MARKER);
      let validated: AgyResult;
      try {
        validated = parseAgyResult(result.stdout);
      } catch (err) {
        // stdout が結果 JSON として復元できず、かつ拒否マーカーが出ているなら、
        // shape 異常(agent-bad-output 等)より根本原因である denial を優先して返す。
        if (denied && err instanceof ChatAgentError) throw new ChatAgentError('agent-headless-denied');
        throw err;
      }
      if (validated.status !== 'SUCCESS') {
        // agy 自身が失敗を報告したケース。ここでも denial が根本原因なら具体的な
        // 分類を優先する。shape は schema どおり正常なので 'agent-unexpected-output'
        // ではなく 'agent-reported-error' に倒す
        // (cursor の is_error: true と同じ理由。bdboard-l1t.5 Opus 再レビュー DF6)。
        throw new ChatAgentError(denied ? 'agent-headless-denied' : 'agent-reported-error');
      }
      if (validated.response === '') {
        // 実測(2026-08-16)の denial はこの形(exit 0・status SUCCESS・空 response・
        // マーカー有り)で返る。マーカー無しで response が空になるケースは実測では
        // 観測していないが、空文字をそのまま「正常応答」としてチャット履歴に
        // 積まないよう shape 異常に倒す。
        throw new ChatAgentError(denied ? 'agent-headless-denied' : 'agent-unexpected-output');
      }
      if (denied) {
        // ターンの途中でツール呼び出しが soft-deny されたが、モデルは最終応答を
        // 返せたケース(MF1)。応答は活かし、運用者が気づけるようログだけ残す。
        // stderr の生テキストはログにも応答にも含めない(bdboard-pvl と同じ配慮で、
        // 固定文言の検知事実のみを書く)。
        console.warn(
          'chat agy-spec: headless auto-deny marker present but the turn still produced a reply; returning the reply (some tool call(s) were soft-denied mid-turn)',
        );
      }
      // bd MCP ツールを一切繋いでいないため failedTools は常に空(cursor と同じ)。
      return { reply: validated.response, sessionId: validated.conversation_id, failedTools: [] };
    },
  };
}
