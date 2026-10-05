/**
 * 届いた issue の「判定した時点の写し」と、いま GitHub にあるものの比較 (bdboard-4y8q.9.1、docs/ISSUE-REPORTING.md 8節)。
 * 写しは `truncateExternalIssue` が返した切り詰め後の題名・本文と、切る前の長さ、GitHub の `updatedAt`。保存は 4y8q.9.3。
 *
 * 比べるのは題名と本文だけ (U9)。`updatedAt` はコメントの追加・ラベルの変更でも進むので、それだけの変化では判定をやり直さない。
 * 設計の「本文と updatedAt が食い違ったら再判定」からのずれで、`updatedAtChanged` は印として返すだけにする。
 */

export interface ExternalIssueSnapshot {
  /** 切り詰めた題名 (`truncateExternalIssue` の `title`)。 */
  readonly title: string;
  /** 切り詰めた本文 (`truncateExternalIssue` の `body`。切ったときの印の文言を含む)。 */
  readonly body: string;
  /** 切る前の題名・本文の長さ (コードポイント)。切った先の編集を、切り詰めた文字列からは見えなくても長さの違いで拾う。 */
  readonly titleLength: number;
  readonly bodyLength: number;
  /** GitHub の `updatedAt` (gh が返した文字列のまま)。 */
  readonly updatedAt: string;
}

export interface SnapshotComparison {
  readonly titleChanged: boolean;
  readonly bodyChanged: boolean;
  readonly updatedAtChanged: boolean;
  /** 判定をやり直す印。題名か本文が変わったとき (`updatedAtChanged` だけでは立てない)。 */
  readonly needsRejudge: boolean;
}

/**
 * 判定時点の写し `snapshot` と、いま読み直して同じ形に整えた `current` を比べる。`current` は
 * `{ ...truncateExternalIssue(raw), updatedAt }` でよい (余分な欄は見ない)。
 * 本文は切り詰めた本文と全長の両方で比べる。切り詰めた先の編集は文字列には現れないが、全長が変われば拾える。
 * (全長を変えない書き換えは拾えない。その先は判定にも渡していないので、判定をやり直す理由にならない。)
 */
export function compareWithSnapshot(snapshot: ExternalIssueSnapshot, current: ExternalIssueSnapshot): SnapshotComparison {
  const titleChanged = snapshot.title !== current.title || snapshot.titleLength !== current.titleLength;
  const bodyChanged = snapshot.body !== current.body || snapshot.bodyLength !== current.bodyLength;
  const updatedAtChanged = snapshot.updatedAt !== current.updatedAt;
  return { titleChanged, bodyChanged, updatedAtChanged, needsRejudge: titleChanged || bodyChanged };
}
