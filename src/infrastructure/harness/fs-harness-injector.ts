// src/infrastructure/harness/fs-harness-injector.ts は bdboard-sso1.40 でモジュール分割された。
// 実体は ./fs-harness-injector/ 配下:
//   - manifest.ts       : マニフェストの parse/serialize と読み書き (readManifestFromDisk /
//     writeManifestToDisk)
//   - pack-files.ts     : hook スクリプト判定 (isHookScript) とパックファイルのコピー /
//     stale ファイル削除
//   - self-injection.ts : 注入先がパック原本を抱える自分自身かの判定 (isSelfInjection)
//   - settings-hooks.ts : .claude/settings.json の読み取りと hook 登録 (registerHooks)
//   - gitignore.ts      : .gitignore への管理行追記
//   - inject-pack.ts    : injectPack() 本体 (上記を組み合わせるワークフロー)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
//
// createFsHarnessInjector() はクラスではなくオブジェクトファクトリで、packsRoot を
// クロージャで捕捉して readManifest/readSettings/injectPack を返す薄い合成層として残す。
// readManifest/readSettings は元々 packsRoot に依存しない閉包だったため、そのまま
// ./fs-harness-injector/manifest.js・./fs-harness-injector/settings-hooks.js の関数を
// 直接プロパティに割り当てている (元のコードと同じ形)。injectPack だけは packsRoot に
// 依存していたため、./fs-harness-injector/inject-pack.js の injectPack() へ、
// クロージャ捕捉していた packsRoot を明示引数に変換して委譲する (挙動は変えていない)。
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import { readManifestFromDisk } from './fs-harness-injector/manifest.js';
import { readSettingsFromDisk } from './fs-harness-injector/settings-hooks.js';
import { injectPack as injectPackImpl } from './fs-harness-injector/inject-pack.js';

export { isHookScript } from './fs-harness-injector/pack-files.js';

export function createFsHarnessInjector(options: {
  readonly packsRoot: string;
}): HarnessInjectorPort {
  const { packsRoot } = options;

  return {
    readManifest: readManifestFromDisk,

    readSettings: readSettingsFromDisk,

    injectPack(projectRootPath, pack, injectedAt) {
      return injectPackImpl(packsRoot, projectRootPath, pack, injectedAt);
    },
  };
}
