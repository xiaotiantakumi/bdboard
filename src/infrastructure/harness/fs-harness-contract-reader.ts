import fs from 'node:fs';
import path from 'node:path';
import type { HarnessContractReaderPort } from '../../application/ports/harness-contract-reader.js';
import { HARNESS_CONTRACT_RELATIVE_PATH } from '../../domain/harness-contract.js';
import { resolveUnderClaudeDir } from '../../domain/harness-path.js';

const PACKAGE_JSON_FILENAME = 'package.json';

export function createFsHarnessContractReader(): HarnessContractReaderPort {
  return {
    async readContract(projectRootPath: string): Promise<string | null> {
      // 注入 API と同じガードを通す。プロジェクトルートの登録が壊れていても
      // `.claude/` の外を読みに行かない。
      const absolute = resolveUnderClaudeDir(
        projectRootPath,
        HARNESS_CONTRACT_RELATIVE_PATH,
      );
      if (absolute === null) {
        return null;
      }

      try {
        return await fs.promises.readFile(absolute, 'utf8');
      } catch {
        return null;
      }
    },

    async readPackageScripts(packageRootPath: string): Promise<readonly string[] | null> {
      let content: string;
      try {
        content = await fs.promises.readFile(
          path.join(packageRootPath, PACKAGE_JSON_FILENAME),
          'utf8',
        );
      } catch {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return null;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }

      const scripts = (parsed as { readonly scripts?: unknown }).scripts;
      if (scripts === undefined) {
        // package.json はあるが scripts が無い = 「その script は存在しない」と
        // 判定できるので、null (判定不能) ではなく空配列を返す。
        return [];
      }
      if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
        return null;
      }

      return Object.keys(scripts);
    },
  };
}
