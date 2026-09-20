import {
  buildHarnessContractTicketContent,
  buildHarnessContractTicketStateChangeComment,
  HARNESS_CONTRACT_TICKET_LABEL,
  HARNESS_CONTRACT_TICKET_PRIORITY,
  HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY,
  HARNESS_CONTRACT_TICKET_TYPE,
} from '../../domain/harness-contract-ticket.js';
import type { ContractState, VerifyPackageScripts } from '../../domain/harness-contract.js';

/**
 * `fileHarnessContractTicket` が要求する IssueWriterPort の部分集合。
 *
 * IssueWriterPort.create / findOpenTicketByLabel / setMetadata は optional
 * (bdboard-p5l.25 / bdboard-13mp) なので、ルーティング層で存在チェックした後この
 * narrower な型へ渡す — この関数の内部では undefined チェックを繰り返さずに済む。
 * addComment は IssueWriterPort 上すでに必須なので、そのままの型で受ける。
 */
export interface HarnessContractTicketWriter {
  findOpenTicketByLabel(
    rootPath: string,
    label: string,
  ): Promise<
    | {
        readonly id: string;
        readonly title: string;
        readonly metadata: Readonly<Record<string, unknown>>;
      }
    | null
  >;
  create(
    rootPath: string,
    input: {
      readonly title: string;
      readonly description: string;
      readonly type: string;
      readonly priority: number;
      readonly labels: readonly string[];
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ): Promise<{ readonly id: string }>;
  addComment(rootPath: string, ticketId: string, text: string): Promise<void>;
  setMetadata(
    rootPath: string,
    ticketId: string,
    key: string,
    value: string,
  ): Promise<void>;
}

/**
 * 既存チケットへの state 変化追記の結果 (bdboard-13mp)。
 *
 * - `not-needed`: 新規作成した (state は作成時点のメタデータへ載せた) か、既存
 *   チケットの記録済み state が現在の state と同じで追記の必要が無かった。
 * - `appended`: 既存チケットへ「現在の状態は…」のコメントを追記し、記録済み
 *   state も更新した。
 * - `failed`: 追記 (comment または setMetadata) を試みたが失敗した。**fail-soft**
 *   — 既存チケット ID を返すこと自体は成功させ、ここで「追記できなかった」ことだけ
 *   呼び出し元 (interface 層 → フロント) へ伝える。
 */
export type HarnessContractTicketStateAppend = 'not-needed' | 'appended' | 'failed';

export type FileHarnessContractTicketResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly created: boolean;
      readonly stateAppend: HarnessContractTicketStateAppend;
    }
  /** 検証コントラクトが `ok` / `not-applicable` — そもそも直すことが無い。 */
  | { readonly ok: false; readonly reason: 'not-applicable' };

export interface FileHarnessContractTicketOptions {
  /**
   * 追記失敗 (fail-soft) の警告ログ。未指定なら console.warn
   * (get-pr-badges.ts 等、application/ 配下の既存の注入流儀と同じ)。
   */
  readonly logWarn?: (message: string) => void;
}

/**
 * 検証コントラクト不足を直すチケットを、そのプロジェクト自身の bd に起票する
 * (bdboard-p5l.25)。
 *
 * 冪等性: `HARNESS_CONTRACT_TICKET_LABEL` の付いた未クローズチケットが既にあれば
 * 作らず、その ID を `created: false` で返す。bd 側 (`bd list --label`) が持つ
 * 「既定で closed を除外する」挙動をそのまま存在確認に使う。
 *
 * **これは真の compare-and-swap ではない** — `findOpenTicketByLabel` の読み取りと
 * `create` の書き込みの間に小さな競合窓がある (レビュー指摘)。この経路はボタンを
 * 押した1リクエストからしか叩けず、実行中はフロント側で操作を無効化するため、
 * 実際に踏むには極めて短い時間窓へ2つのブラウザセッションから同時にクリックする
 * 必要がある。踏んでも起きるのは「閉じれば済む P2 チケットが2枚になる」程度なので、
 * ここでは許容している。真の CAS (例: bd 側の一意制約) が要る場合は別途検討する。
 *
 * ## state 遷移をまたいだ陳腐化チケットの扱い (bdboard-13mp)
 *
 * ラベルは state ごとに分けず `HARNESS_CONTRACT_TICKET_LABEL` を使い回す。既存の
 * 未クローズチケットが見つかったとき、そのチケットの
 * `HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY` メタデータ (起票時/最後に追記した
 * state) が現在の `contract.state` と**違う場合だけ**「現在の状態は…」のコメントを
 * 追記し、メタデータも現在の state へ更新する。同じ state なら何もしない (ボタン
 * 連打でコメントが積み上がらない = 冪等)。メタデータの無い旧チケット (この仕組み
 * 導入前に起票されたもの) は「state 不明」として扱われ、現在の state と一致する
 * はずがないので必ず1回だけ追記され、以後はメタデータが付くので同じ state が
 * 続く限り再追記されない。
 *
 * コメント追記/メタデータ更新の失敗は fail-soft: 既存チケット ID を返す動作自体は
 * 成功させ、`stateAppend: 'failed'` で呼び出し元に伝える (ログは `logWarn`)。
 *
 * **ここにも真の CAS ではない小さな競合窓がある** (上の新規作成パスと同じ注意書き
 * — レビュー指摘)。`findOpenTicketByLabel` の読み取りと `addComment`/`setMetadata`
 * の書き込みの間に、2つのリクエストが両方とも同じ古い metadata を読んで両方とも
 * 追記してしまう窓がある。踏んだ場合に起きるのは「同じ内容のコメントが2回付く」
 * 程度 (新規作成パスの「チケットが2枚になる」より実害が小さい) なので、新規作成
 * パスと同じ理由でここでも許容している。
 */
export async function fileHarnessContractTicket(
  issueWriter: HarnessContractTicketWriter,
  rootPath: string,
  contract: ContractState,
  rootPackageScripts: VerifyPackageScripts,
  options?: FileHarnessContractTicketOptions,
): Promise<FileHarnessContractTicketResult> {
  const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));

  const content = buildHarnessContractTicketContent(contract, rootPackageScripts);
  if (content === null) {
    return { ok: false, reason: 'not-applicable' };
  }

  const existing = await issueWriter.findOpenTicketByLabel(
    rootPath,
    HARNESS_CONTRACT_TICKET_LABEL,
  );

  if (existing !== null) {
    const recordedState = existing.metadata[HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY];
    if (recordedState === contract.state) {
      return {
        ok: true,
        ticketId: existing.id,
        created: false,
        stateAppend: 'not-needed',
      };
    }

    // recordedState !== contract.state: メタデータが無い旧チケット (undefined) も
    // ここに含まれ、「state 不明」として1回だけ扱われる。buildHarnessContractTicketContent
    // が null を返さないことは上のガードで保証済みなので、対応する comment も必ず
    // 非 null (buildHarnessContractTicketStateChangeComment は同じ switch で null を
    // 返す場合を判定している)。
    const comment = buildHarnessContractTicketStateChangeComment(
      contract,
      rootPackageScripts,
    );
    if (comment === null) {
      // 上の content !== null ガードと同じ switch を見ている (buildHarnessContractTicketContent
      // と buildHarnessContractTicketStateChangeComment は同じ contract.state で分岐する) ので
      // ここには到達しないはずだが、両者が将来ズレても "as string" で握りつぶさず即座に
      // わかるようにしておく (レビュー指摘)。
      throw new Error(
        `buildHarnessContractTicketStateChangeComment unexpectedly returned null for state=${contract.state}`,
      );
    }
    try {
      // 追記 (comment) → メタデータ更新の順で行う。逆順にすると、コメントが失敗した
      // ときにメタデータだけ更新済みになり「追記した体で実は通知が残っていない」
      // (silent loss) という、この順序より悪い失敗モードになる。この順序でも
      // comment 成功・setMetadata 失敗のケースは残る (comment 自体は届いているのに
      // stateAppend: 'failed' を返すため、次のクリックで同じコメントが重複追記され得る) —
      // 許容トレードオフとして残す (レビュー指摘、bdboard-13mp)。
      await issueWriter.addComment(rootPath, existing.id, comment);
      await issueWriter.setMetadata(
        rootPath,
        existing.id,
        HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY,
        contract.state,
      );
      return {
        ok: true,
        ticketId: existing.id,
        created: false,
        stateAppend: 'appended',
      };
    } catch (error: unknown) {
      // fail-soft: 既存チケットが見つかったという成功結果は変えず、追記に失敗した
      // ことだけを呼び出し元に伝える。
      const detail = error instanceof Error ? error.message : String(error);
      logWarn(
        `failed to append harness contract state change to ${existing.id} ` +
          `(rootPath=${rootPath}): ${detail}`,
      );
      return {
        ok: true,
        ticketId: existing.id,
        created: false,
        stateAppend: 'failed',
      };
    }
  }

  const created = await issueWriter.create(rootPath, {
    title: content.title,
    description: content.description,
    type: HARNESS_CONTRACT_TICKET_TYPE,
    priority: HARNESS_CONTRACT_TICKET_PRIORITY,
    labels: [HARNESS_CONTRACT_TICKET_LABEL],
    metadata: { [HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY]: contract.state },
  });

  return { ok: true, ticketId: created.id, created: true, stateAppend: 'not-needed' };
}
