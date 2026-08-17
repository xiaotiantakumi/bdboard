import os from 'node:os';
import path from 'node:path';
import type { FileSystemPort } from '../../application/ports/file-system.js';

export async function resolveDefaultScanRoots(
  fs: FileSystemPort,
  opts?: { platform?: NodeJS.Platform; homedir?: string },
): Promise<readonly string[]> {
  const platform = opts?.platform ?? process.platform;

  let home: string;
  if (opts?.homedir !== undefined) {
    home = opts.homedir;
  } else if (platform === 'win32') {
    const userProfile = process.env.USERPROFILE?.trim();
    home = userProfile && userProfile.length > 0 ? userProfile : os.homedir();
  } else {
    home = os.homedir();
  }

  const documents = path.join(home, 'Documents');
  if (await fs.isDirectory(documents)) {
    return [documents];
  }
  return [home];
}
