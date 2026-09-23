// bdboard-sso1.54: cloudflared-tunnel.ts の move-only 分割で切り出した cloudflared
// 実行ファイルの PATH 探索。挙動は一切変えていない(移動のみ)。
import fs from 'node:fs';
import path from 'node:path';

export function resolveCloudflaredInPath(
  pathEnv: string,
  opts?: { platform?: NodeJS.Platform },
): string | null {
  const platform = opts?.platform ?? process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const executableName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const directories = pathEnv.split(platformPath.delimiter);

  for (const directory of directories) {
    if (directory.length === 0) {
      continue;
    }

    const candidate = platformPath.join(directory, executableName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next directory
    }
  }

  return null;
}
