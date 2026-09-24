/**
 * bdboard-sso1.86: src/main.ts (composition root) からキャッシュ/コマンド
 * 実行・各種ファイル設定ストアの組み立てを切り出したもの (move only, 挙動変更ゼロ)。
 *
 * bd バージョンチェックは診断目的のみで起動を止めないため、ここでも
 * fire-and-forget (`void`) のまま kick する。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createFileAiQuotaAlertConfigStore,
  createFileBoardThresholdsConfigStore,
  createFileHygieneThresholdsConfigStore,
  createFileScanRootsConfigStore,
  createSqliteBoardCache,
  NodeCommandRunner,
  NodeFileSystem,
  NodeStreamingCommandRunner,
  readBdVersion,
} from '../infrastructure/index.js';
import { runBdVersionStartupCheck } from '../application/bd/run-bd-version-startup-check.js';
import { envString } from './env.js';

export interface WireCoreInfraDeps {
  readonly dbPath: string;
  readonly configFilePath: string;
  readonly bdPath: string;
  readonly bdVersionCheckTimeoutMs: number;
  readonly log?: Pick<typeof console, 'log' | 'warn' | 'error'>;
}

export function wireCoreInfra(deps: WireCoreInfraDeps) {
  const log = deps.log ?? console;

  fs.mkdirSync(path.dirname(deps.dbPath), { recursive: true });

  const cache = createSqliteBoardCache(deps.dbPath);
  const fsPort = new NodeFileSystem();
  const commandRunner = new NodeCommandRunner();
  // 診断だけが目的なので、bd が未導入・壊れている場合も起動を止めない。
  void runBdVersionStartupCheck(
    () => readBdVersion(commandRunner, deps.bdPath, deps.bdVersionCheckTimeoutMs, process.cwd()),
    log,
  );
  const streamingCommandRunner = new NodeStreamingCommandRunner();
  const configFilePath = deps.configFilePath;
  const scanRootsConfigStore = createFileScanRootsConfigStore(
    envString('BDBOARD_SCAN_ROOTS_CONFIG_PATH', configFilePath),
  );
  const boardThresholdsConfigStore = createFileBoardThresholdsConfigStore(
    envString('BDBOARD_BOARD_THRESHOLDS_CONFIG_PATH', configFilePath),
  );
  const hygieneThresholdsConfigStore = createFileHygieneThresholdsConfigStore(
    envString('BDBOARD_HYGIENE_THRESHOLDS_CONFIG_PATH', configFilePath),
  );
  const aiQuotaAlertConfigStore = createFileAiQuotaAlertConfigStore(
    envString('BDBOARD_AI_QUOTA_ALERT_CONFIG_PATH', configFilePath),
  );

  return {
    cache,
    fsPort,
    commandRunner,
    streamingCommandRunner,
    configFilePath,
    scanRootsConfigStore,
    boardThresholdsConfigStore,
    hygieneThresholdsConfigStore,
    aiQuotaAlertConfigStore,
  };
}
