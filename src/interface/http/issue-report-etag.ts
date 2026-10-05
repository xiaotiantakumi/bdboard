import type { Context } from 'hono';
import type { IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import type { IssueDraft } from '../../domain/issue-draft.js';
import { computeStrongEtag, etagDigestOf, ifMatchAccepts, ifNoneMatchMatches } from './etag.js';
import {
  toDetailDto,
  toImageDto,
  type IssueDraftDetailDto,
  type IssueDraftImageDto,
  type IssueDraftSummaryDto,
} from './issue-report-dto.js';
import type { RestrictedLeakCache } from './issue-report-leak-cache.js';

/**
 * 不具合報告の下書き API の条件付き GET (If-None-Match → 304) と、編集の If-Match (不一致 → 412) の元になる ETag
 * (bdboard-mqoa、docs/ISSUE-REPORTING.md 3節「条件付き GET と編集の If-Match」)。HTTP のヘッダはこの層に閉じる。
 *
 * 1 件の取得の ETag は `"<editDigest>-<bodyDigest>"` (bdboard-q5pj)。後半の bodyDigest は「応答の本文そのもの」の版: 下書きの
 * 中身の版 (draft.json のダイジェスト) だけでなく、応答に入る画像の一覧・最新の harness pack の版・ローカル/トンネルで絞った形・
 * DTO の形と検出の規則まで、応答の本文に出るものを全部含む。下書きの版だけから作ると、画像の追加や bdboard の更新のあとも 304 で
 * 古い本文を使い続けてしまう。本文は組み立てたあとの値 (DTO) から作るので、そのどれかが変わったのに ETag が変わらない、ということが
 * 起きない。If-None-Match (304) はこの全体で比べる。前半の editDigest は利用者が直せる欄だけの版 (editDigestOf) で、編集の
 * If-Match (412) はこちらだけで比べる: 新しい発生・画像の追加・pack の版の変化だけでは、直した欄が変わっていない編集を 412 にしない。
 * 一覧の ETag は従来どおり本文全体の 1 つのダイジェスト (If-Match の相手ではない)。
 * 保存形の欄 (版の番号) は足していない: 手で書き換えた draft.json や、書き込みの経路の足し忘れでも、版が古いままにならない。
 */

/** 1 件の取得 (GET drafts/:id) の応答の本文。 */
export interface IssueDraftDetailBody {
  readonly draft: IssueDraftDetailDto;
  readonly images: readonly IssueDraftImageDto[];
  readonly latestHarnessVersion: string | null;
}

/** 一覧 (GET drafts) の応答の本文。 */
export interface IssueDraftListBody {
  readonly drafts: readonly IssueDraftSummaryDto[];
  readonly pendingCount: number;
}

/**
 * キーを並べ替えた JSON。同じ内容なら同じ文字列になる: 保存層は draft.json を読むとき zod でキーの順を直すので、
 * 編集した直後のメモリ上の下書き (編集前のキーの順を引き継ぐ) と、次に読み直した下書きで、JSON.stringify の結果が違いうる。
 * 順が違うだけで ETag が変わると、保存の応答の ETag で次の PATCH を送ったときに 412 になる。undefined の欄は無いものとして扱う。
 * 先に JSON を通す: toJSON を持つ値 (Date・Buffer) は応答の本文では文字列などになるので、通さないと {} に見えて値の変化を拾えない。
 */
export function canonicalJson(value: unknown): string {
  return canonicalOf(JSON.parse(JSON.stringify(value) ?? 'null'));
}

function canonicalOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOf).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalOf(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 利用者が直せる欄の版 (editDigestOf) の入力。1 件の取得の応答の draft から、この欄だけ取る。 */
export type EditableDraftFields = Pick<
  IssueDraftDetailDto,
  'id' | 'status' | 'title' | 'body' | 'titleEditedByUser' | 'bodyEditedByUser'
>;

/**
 * 編集 (PATCH) の If-Match が見る版: 利用者が直せる欄だけのダイジェスト。入るのは id・status・題名と本文の「直した」印と、
 * 直した欄の文だけ。自動で組んだ欄の文は null として入れない: 同じ指紋の新しい発生 (回数・時刻・手元の版) のたびに作り直されるので、
 * 入れると、利用者が何も直していなくても読んだあとの発生で偽の 412 になる (bdboard-q5pj)。回数・画像・pack の版・疑い
 * (直した欄と鍵から決まる) も入れない。PATCH は排他の中で今の下書きに題名・本文を当てるので、それらは上書きで失われない。
 * 文は応答の draft の値 (トンネルでは foldHomePaths で畳んだ値) から作るので、トンネルの読み手へ畳む前の文の指紋を渡さない。
 *
 * 保守: PATCH が書き換えられる欄 (issue-report-edit-routes.ts の editBodySchema と EditableDraftFields) を足すときは、ここ (editDigestOf) にも
 * 入れる。入れ忘れると、その欄を別の場所で直された編集が If-Match を通り、同時の上書きが黙って成功する (412 にならない)。
 */
export function editDigestOf(draft: EditableDraftFields): string {
  return etagDigestOf(
    canonicalJson({
      id: draft.id,
      status: draft.status,
      titleEditedByUser: draft.titleEditedByUser,
      bodyEditedByUser: draft.bodyEditedByUser,
      title: draft.titleEditedByUser ? draft.title : null,
      body: draft.bodyEditedByUser ? draft.body : null,
    }),
  );
}

/**
 * 1 件の取得の応答の ETag (強い ETag)。`"<editDigest>-<bodyDigest>"`: 前半は直せる欄だけの版 (editDigestOf)、後半は応答の本文全体の版。
 * If-None-Match (304) は全体で比べるので、本文のどこが変わっても変わる。If-Match (PATCH) は前半だけで比べる (ifMatchMatchesEdit)。
 * PATCH の応答の ETag も、同じ関数で作った値を使う。
 */
export function detailEtagOf(body: IssueDraftDetailBody): string {
  return `"${editDigestOf(body.draft)}-${etagDigestOf(canonicalJson(body))}"`;
}

const DETAIL_ETAG_TOKEN = /^([0-9a-f]{32})-[0-9a-f]{32}$/;

/**
 * 編集の If-Match を、今の下書きの直せる欄の版 (editDigestOf) だけで判定する。If-Match の中の ETag (ここが返した `"<editDigest>-<bodyDigest>"`)
 * は前半だけを見て、後半 (本文全体の版) は見ない。`*`・リスト・`W/`・空・読めない値の扱いは etag.ts の ifMatchAccepts のとおり
 * (読めない値には、前の形の ETag `"<32 桁>"` も入る: ここの形ではないので一致しない = 412。読み直せば新しい形になる)。
 */
export function ifMatchMatchesEdit(ifMatch: string, current: EditableDraftFields): boolean {
  const expected = editDigestOf(current);
  return ifMatchAccepts(ifMatch, (token) => DETAIL_ETAG_TOKEN.exec(token)?.[1] === expected);
}

/** 一覧の応答の ETag。並び順 (配列の順) と未処理件数も本文に入っているので、どちらが変わっても変わる。 */
export function listEtagOf(body: IssueDraftListBody): string {
  return computeStrongEtag(canonicalJson(body));
}

export interface IssueDraftDetailBodyDeps {
  readonly service: IssueDraftService;
  readonly leakCache: RestrictedLeakCache;
}

/**
 * 1 件の取得の応答の本文を組む。最新の harness pack の版は呼び出し側が読んで渡す: PATCH の If-Match の判定は
 * 書き込みの排他の中で動くので、そこで pack を読み直さない。画像の一覧は draft から読む (下書きが消えていれば空)。
 */
export async function buildDetailBody(
  deps: IssueDraftDetailBodyDeps,
  draft: IssueDraft,
  access: { readonly local: boolean; readonly latestHarnessVersion: string | null },
): Promise<IssueDraftDetailBody> {
  const images = (await deps.service.listImages(draft.id)) ?? [];
  return {
    draft: toDetailDto(draft, { local: access.local, leakCache: deps.leakCache }),
    images: images.map((image) => toImageDto(draft.id, image)),
    latestHarnessVersion: access.latestHarnessVersion,
  };
}

/**
 * ETag・Cache-Control を付けて、If-None-Match が一致すれば 304 (本文なし。ETag は付ける)、そうでなければ本文を返す。
 * `private, no-cache`: 手元の生ログを含む応答なので共有キャッシュには置かせず、ブラウザには毎回確かめさせる (304 で済む)。
 * Vary は、gzip を掛けない 304 にも付ける (hono/compress は掛けた応答にだけ付ける。board-routes.ts と同じ)。
 * 認証・認可はこの前の層 (Basic 認証・書き込みガード) で済んでいるので、資格の無い相手には 304 ではなく 401/403 が返る。
 */
export function jsonWithEtag(c: Context, body: IssueDraftDetailBody | IssueDraftListBody, etag: string): Response {
  c.header('ETag', etag);
  c.header('Cache-Control', 'private, no-cache');
  c.header('Vary', 'Accept-Encoding');
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch !== undefined && ifNoneMatchMatches(ifNoneMatch, etag)) return c.body(null, 304);
  return c.json(body);
}
