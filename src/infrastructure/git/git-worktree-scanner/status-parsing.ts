import { compareStrings } from '../../../domain/compare.js';
import { splitNulRecords } from './nul-records.js';

/**
 * `git status --porcelain -z` を分解する。
 *
 * `-z` を使うのは引用符処理を避けるため。`-z` 無しの porcelain は非 ASCII や空白を
 * 含むパスを `"..."` でエスケープして返すので、日本語ファイル名やスペース入りの
 * パスを素朴に slice すると壊れる。rename / copy のときは次のレコードが元パスに
 * なるので、両方を「触ったファイル」として拾う。
 *
 * 呼び出し側は `--untracked-files=all` を付ける。既定の `normal` は未追跡ディレクトリを
 * `?? newdir/` の 1 行に畳んでしまい、その中のファイルが重複判定に載らない。
 */
export function parseStatusPorcelainZ(output: string): string[] {
  const records = splitNulRecords(output);
  const files: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    // 最短でも "XY p" の 4 文字。ここに満たないものは status 行ではない
    if (record.length < 4) {
      continue;
    }

    const x = record[0]!;
    const y = record[1]!;
    files.push(record.slice(3));

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const source = records[index + 1];
      if (source !== undefined) {
        files.push(source);
        index += 1;
      }
    }
  }

  return files;
}

export function normalizeFiles(files: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const file of files) {
    if (file.length > 0) {
      unique.add(file);
    }
  }
  return [...unique].sort(compareStrings);
}
