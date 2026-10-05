// bdboard-rqzv / bdboard-jb5x: ファイルの中身の文字コードの判別とデコード。
// UTF-16 (BOM 付き) で保存されたファイルは UTF-8 として読むと NUL 混じりの別の文字列になり何も検出できないので、BOM で判別して
// デコードし分ける。BOM の無い UTF-16 は判別しない。

// 'utf16le' / 'utf16be' (BOM 付き) / 'utf8' (それ以外。UTF-8 の BOM 付きも含む)。診断の直し方を変えるために main も使う。
export function sourceEncoding(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
  return 'utf8';
}

// ファイルの中身を文字列にする。BOM (U+FEFF) 自体は文字列の先頭に残るので、通常の UTF-8 の BOM と同じく 1:1 の検出になる
// (リポジトリのソースに BOM は要らない)。UTF-16 の末尾の余りの 1 バイトは捨てる。
export function decodeSource(buffer) {
  const encoding = sourceEncoding(buffer);
  if (encoding === 'utf8') return buffer.toString('utf8');
  const evenLength = buffer.length - (buffer.length % 2);
  const body = Buffer.from(buffer.subarray(0, evenLength));
  return (encoding === 'utf16be' ? body.swap16() : body).toString('utf16le');
}
