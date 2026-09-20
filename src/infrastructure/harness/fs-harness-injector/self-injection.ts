import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from '../../../domain/harness-path.js';

/** 実体パスに解決する。解決できない (未作成など) ときは正規化した元のパスを返す。 */
async function resolveRealPath(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 注入先がパック原本 (`packsRoot`) を抱えている repo 自身か。
 *
 * bdboard 自身は `.claude/bdboard-packs.json` と `.claude/skills/<pack>/` を git
 * 追跡しているため (p5l.7 の裁定)、Hygiene パネルから自己再注入したときに
 * `.gitignore` へ管理行が入ると、以後パックにファイルを足しても git add から
 * 静かに漏れる。自己注入と判定できたときは .gitignore を触らない (bdboard-x32)。
 *
 * realpath まで見るのは macOS の `/var` -> `/private/var` のように、同じ場所を
 * 指す別表記でプロジェクトが登録されていても取りこぼさないため。解決に失敗した
 * 場合は正規化した元のパスで比べる — その場合の最悪は「自己注入を見逃して
 * 従来どおり追記する」で、現状より悪くはならない。
 *
 * 判定は「packsRoot が注入先の内側か」なので、bdboard を内包する**祖先**
 * ディレクトリへ注入した場合も self 側へ倒れる (PR#138 レビュー minor-1)。
 * これは意図的: 誤って倒れたときの実害は「ignore 行が付かず注入物が untracked
 * のまま残る」で、逆方向の「git add から静かに漏れる」より軽い。なお
 * プロジェクト探索は `.beads` を見つけた時点で降下を止めるので、祖先と bdboard
 * が同時に一覧へ並ぶ構成自体が例外的である。
 */
export async function isSelfInjection(projectRootPath: string, packsRoot: string): Promise<boolean> {
  const [projectReal, packsReal] = await Promise.all([
    resolveRealPath(projectRootPath),
    resolveRealPath(packsRoot),
  ]);
  return isPathInside(projectReal, packsReal);
}
