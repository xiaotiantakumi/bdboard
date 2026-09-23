/** NUL 区切り出力を分解する。末尾の空要素だけ落とす (途中の空要素は位置がずれるので残す) */
export function splitNulRecords(output: string): string[] {
  const records = output.split('\0');
  while (records.length > 0 && records[records.length - 1] === '') {
    records.pop();
  }
  return records;
}
