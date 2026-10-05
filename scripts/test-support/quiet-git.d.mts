// bdboard-5py8: scripts/test-support/quiet-git.mjs の型宣言。src/ の TypeScript テスト (一時 git repo で commit / fetch / push する
// ものたち) が同じ補助を import できるようにするためのもので、実装は .mjs の 1 か所だけ (設定の中身が 2 か所に分かれない)。
// tsc (rootDir=src) は .mjs を取り込まない (allowJs 無し) ので、型は import 解決でこの宣言ファイルが拾われる。
import type { RmOptions } from 'node:fs';

export declare const RM_OPTIONS: RmOptions;
export declare const QUIET_GIT_CONFIG: string;
export declare function quietGitEnv(dir: string): { GIT_CONFIG_GLOBAL: string };
export declare function useQuietGitProcessEnv(): void;
