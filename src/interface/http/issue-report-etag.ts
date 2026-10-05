import type { Context } from 'hono';
import type { IssueDraftService } from '../../application/issue-report/issue-draft-service.js';
import type { IssueDraft } from '../../domain/issue-draft.js';
import { computeStrongEtag, ifNoneMatchMatches } from './etag.js';
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
 * ETag は「応答の本文そのもの」の版: 下書きの中身の版 (draft.json のダイジェスト) だけでなく、応答に入る画像の一覧・最新の
 * harness pack の版・ローカル/トンネルで絞った形・DTO の形と検出の規則まで、応答の本文に出るものを全部含む。下書きの版だけ
 * から作ると、画像の追加や bdboard の更新のあとも 304 で古い本文を使い続けてしまう。本文は組み立てたあとの値 (DTO) から
 * 作るので、そのどれかが変わったのに ETag が変わらない、ということが起きない。
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

/** 1 件の取得の応答の ETag (強い ETag)。PATCH の応答の ETag と If-Match の判定も、同じ関数で作った値を使う。 */
export function detailEtagOf(body: IssueDraftDetailBody): string {
  return computeStrongEtag(canonicalJson(body));
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
