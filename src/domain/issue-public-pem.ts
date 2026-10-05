/**
 * 秘密鍵ブロックの探索 (bdboard-4y8q.2、docs/ISSUE-REPORTING.md 5節の置き換え規則 4)。
 *
 * 見つける形 (大文字小文字は問わない):
 *   - PEM: "-----BEGIN RSA PRIVATE KEY-----" … "-----END RSA PRIVATE KEY-----" (EC・OPENSSH・ENCRYPTED・PGP の
 *     "PRIVATE KEY BLOCK" も)。
 *   - SSH2 (RFC 4716 の鍵の形): "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----" … "---- END SSH2 …----" (ダッシュは 3〜5 個、空白は任意)。
 *   - PuTTY: "PuTTY-User-Key-File-3: ssh-ed25519" で始まる鍵ファイル (終わりの印が無いので、文章の終わりまで)。
 *
 * 組み立て方 (BEGIN/END の印を位置の順に 1 回だけ見る状態機械):
 *   - BEGIN → 開く (開いている間の BEGIN は無視)。END → 開いていれば、そこまでを 1 つのブロックにして閉じる。
 *   - END が無いまま文章が終わったとき (ログが途中で切れた): BEGIN から文章の終わりまで。
 *   - BEGIN の無い END (出力の末尾の N 行だけを取ったログ): 直前のブロックの終わり (無ければ文章の先頭) から END まで。
 *     鍵の本体が END の前に続いているので、本体が残るより前を消しすぎるほうを選ぶ。
 * つまり、文章の中の BEGIN/END の印は、必ずどれかのブロックの内側に入る。最後の網 (issue-public-leaks.ts) が
 * 印を単独で報告するには、完成した本文に印が 1 つでも残っていれば、このブロックの探索が必ず見つける、という性質で足りる。
 *
 * 線形: 正規表現は定数で、印の名前の部分は {0,40} で上限を付け (長い空白の連なりで先読みが伸びない)、BEGIN ごとに END を
 * 探し直さず、印の列を 1 回走査する (BEGIN ごとの遅延量指定子 `[\s\S]*?` は使わない)。
 */
export interface PemSpan {
  readonly start: number;
  readonly end: number;
}

// ダッシュは 3〜5 個 (ログの折り返しや整形で 1〜2 個落ちた形も拾う)、ラベルにはハイフンも許す ("EC-X PRIVATE KEY")。
const NAME = String.raw`[A-Z0-9 -]{0,40}PRIVATE KEY(?: BLOCK)?`;
const BEGIN_SOURCE = String.raw`-{3,5} ?BEGIN ${NAME} ?-{3,5}|PuTTY-User-Key-File-[0-9]+:`;
const END_SOURCE = String.raw`-{3,5} ?END ${NAME} ?-{3,5}`;

interface Marker {
  readonly kind: 'begin' | 'end';
  readonly start: number;
  readonly end: number;
}

function markersOf(text: string): Marker[] {
  const begins = [...text.matchAll(new RegExp(BEGIN_SOURCE, 'gi'))].map(
    (match): Marker => ({ kind: 'begin', start: match.index, end: match.index + match[0].length }),
  );
  const ends = [...text.matchAll(new RegExp(END_SOURCE, 'gi'))].map(
    (match): Marker => ({ kind: 'end', start: match.index, end: match.index + match[0].length }),
  );
  return [...begins, ...ends].sort((left, right) => left.start - right.start);
}

export function findKeyBlockSpans(text: string): PemSpan[] {
  const spans: PemSpan[] = [];
  let open: number | undefined;
  let cursor = 0;
  for (const marker of markersOf(text)) {
    if (marker.kind === 'begin') {
      open ??= marker.start;
    } else {
      spans.push({ start: open ?? cursor, end: marker.end });
      cursor = marker.end;
      open = undefined;
    }
  }
  if (open !== undefined) spans.push({ start: open, end: text.length });
  return spans;
}
