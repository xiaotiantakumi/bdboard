/**
 * JSONL の増分読み取りで、チャンクから「完結している行だけ」を切り出し、
 * そこまでのバイトオフセットを返す。
 *
 * 行の切り出しと committedOffset の算出は必ず生 Buffer 上のバイト境界で行う。
 * デコード済み文字列を再エンコードすると、チャンク先頭が多バイト文字の途中で切れたときに
 * U+FFFD 置換でバイト長が膨らみ、オフセットが実際より進む(bdboard-3tw.105)。
 *
 * 元は jsonl-interaction-reader 内のローカル関数だったが、transcript scanner が
 * 同じ取りこぼしを起こしていた(bdboard-32u)ため共有に切り出した。両者とも
 * planScan の ScanSlice を消費する側なので、置き場所も scan-plan と同じ階層にする。
 *
 * @param buffer チャンクの生バイト列
 * @param sliceStart このチャンクがファイル先頭から何バイト目で始まるか
 * @param isTailRestart 末尾からの読み直し。先頭の欠けた行を捨てる必要がある
 */
export function extractCompleteLines(
  buffer: Buffer,
  sliceStart: number,
  isTailRestart: boolean,
): { readonly text: string; readonly committedOffset: number } {
  let startByteInChunk = 0;
  if (isTailRestart && sliceStart > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) {
      return { text: '', committedOffset: sliceStart };
    }
    startByteInChunk = firstNewline + 1;
  }

  if (startByteInChunk >= buffer.length) {
    return { text: '', committedOffset: sliceStart + startByteInChunk };
  }

  let endByteInChunk = buffer.length;
  if (buffer[buffer.length - 1] !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < startByteInChunk) {
      return { text: '', committedOffset: sliceStart + startByteInChunk };
    }
    endByteInChunk = lastNewline + 1;
  }

  const completeBytes = buffer.subarray(startByteInChunk, endByteInChunk);
  const text = completeBytes.toString('utf8');
  const committedOffset = sliceStart + endByteInChunk;
  return { text, committedOffset };
}
