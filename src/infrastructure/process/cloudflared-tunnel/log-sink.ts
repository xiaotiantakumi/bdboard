// bdboard-sso1.54: cloudflared-tunnel.ts の move-only 分割で切り出したログシンク関連。
// ログファイルパス解決・秘匿マスキング・ローテーション・書き込み先(LogSink)実装を
// まとめた関心。挙動は一切変えていない(移動のみ)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * cloudflared のログ既定パスを解決する。
 *
 * 以前は `path.join(process.cwd(), 'logs', ...)` だった (bdboard-3b0)。配布形態
 * (`npx bdboard`) は任意の cwd から起動されるので、cwd 基準だとトンネルを開いた
 * 瞬間に「ユーザーがたまたま居たディレクトリ」へ `logs/` を掘ることになる。
 * ホームディレクトリだろうが他人のリポジトリのルートだろうが掘る。
 *
 * 置き場はキャッシュ DB (`~/.bdboard/cache.db`, src/main.ts) と同じ `~/.bdboard/`
 * に揃えた。設定ファイル (`~/.config/bdboard/config.json`, infrastructure/fs/
 * config-path.ts) の側ではない — ログは人が編集する設定ではなく実行時生成物
 * なので、既に実行時生成物が置かれている場所に寄せる方が一貫する。
 *
 * homedir を注入できるのはテスト用。os.homedir() は Windows でもユーザー
 * プロファイルを返すので、プラットフォーム分岐は要らない。
 */
export function resolveDefaultTunnelLogFilePath(opts?: {
  homedir?: string;
}): string {
  const home = opts?.homedir ?? os.homedir();
  return path.join(home, '.bdboard', 'logs', 'cloudflared-tunnel.log');
}

/** ログファイルの既定サイズ上限(5MB)。超過すると .log -> .log.1 へ退避される。 */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

// cloudflared の標準出力に資格情報が乗ることは通常無いが、事後調査用ログとして残す以上、
// 万一それらしき文字列が混ざっていた場合の最終防衛として伏せ字にする。
const SECRET_LIKE_PATTERN = /\b(password|passwd|token|secret|authorization)\s*[:=]\s*\S+/gi;

export function maskSecrets(text: string): string {
  return text.replace(SECRET_LIKE_PATTERN, (match) => {
    const separatorIndex = match.search(/[:=]/);
    return `${match.slice(0, separatorIndex + 1)} ***`;
  });
}

/**
 * cloudflared の出力の書き込み先を抽象化する(テストではフェイクを注入する)。
 *
 * 契約: write/close は例外を投げてはならない。呼び出し側 (onData / close ハンドラ)
 * は無防備に呼ぶため、投げるとログの都合でトンネル動作が壊れる — この方針は
 * 生成失敗にもフォールバックを入れて揃えた (bdboard-nte)。
 */
export interface LogSink {
  write(chunk: string): void;
  close(): void;
}

/**
 * filePath が maxBytes 以上であれば filePath -> `${filePath}.1` へリネームして退避する
 * (世代は1つのみ。既存の .1 があれば上書きされる)。ファイルが存在しない場合は何もしない。
 * 起動時チェック程度の粗い運用でよいため、書き込み中の継続監視は行わない。
 */
function rotateLogFileIfOversized(filePath: string, maxBytes: number): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return; // ファイルがまだ無い(初回起動など)
  }

  if (stats.size < maxBytes) {
    return;
  }

  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // ローテーション失敗時は既存ファイルへの追記を続ける(ベストエフォート)
  }
}

/**
 * 何も書かないシンク。ログ出力先を用意できなかったときのフォールバック
 * (bdboard-nte)。
 */
export function createNoopLogSink(): LogSink {
  return {
    write: () => {},
    close: () => {},
  };
}

export function createFileLogSink(filePath: string, maxBytes: number): LogSink {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  rotateLogFileIfOversized(filePath, maxBytes);
  const fd = fs.openSync(filePath, 'a');
  return {
    write: (chunk: string) => {
      try {
        fs.writeSync(fd, chunk);
      } catch {
        // ログ書き込み失敗はトンネル動作自体を阻害しない
      }
    },
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed, ignore
      }
    },
  };
}
