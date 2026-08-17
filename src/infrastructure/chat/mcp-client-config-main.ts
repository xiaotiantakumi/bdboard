import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpClientConfigs } from '../../application/chat/mcp-client-config.js';

type OutputTarget = 'claude' | 'codex' | 'cursor' | 'all';

interface ParsedArgs {
  readonly projectRootPath: string;
  readonly bdPath: string;
  readonly serverName: string;
  readonly target: OutputTarget;
  readonly help: boolean;
}

const VALID_TARGETS = new Set<OutputTarget>(['claude', 'codex', 'cursor', 'all']);

const VALUE_FLAGS = new Set(['--project-root', '--bd-path', '--name', '--target']);

/**
 * 値を取るフラグの引数を取り出す。値が欠けている場合は「不明な引数」ではなく
 * 「値が要る」と報告する (末尾に `--project-root` だけ書いたときの誤解を防ぐ)。
 */
function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || VALUE_FLAGS.has(value)) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write(`Usage: npm run mcp:config -- [options]

Options:
  --project-root <abs>  bd project root (default: process.cwd(), resolved to absolute)
  --bd-path <path>      bd binary (default: bd)
  --name <name>         MCP server name (default: bd)
  --target <target>     claude | codex | cursor | all (default: all)
  --help                Show this help
`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let projectRootPath = process.cwd();
  let bdPath = 'bd';
  let serverName = 'bd';
  let target: OutputTarget = 'all';
  let help = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--project-root') {
      const value = requireValue(argv, index, arg);
      projectRootPath = path.isAbsolute(value)
        ? value
        : path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    if (arg === '--bd-path') {
      bdPath = requireValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--name') {
      serverName = requireValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--target') {
      const value = requireValue(argv, index, arg);
      if (!VALID_TARGETS.has(value as OutputTarget)) {
        throw new Error(`unknown --target value: ${value}`);
      }
      target = value as OutputTarget;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return { projectRootPath, bdPath, serverName, target, help };
}

function writeNotice(): void {
  process.stdout.write(
    '# この出力には絶対パス (ホームディレクトリ配下) が含まれます。リポジトリにコミットしないでください。\n',
  );
  process.stdout.write(
    '# この設定にトークン等のシークレットは含まれません。含めないでください。\n\n',
  );
}

function writeClaudeSection(claudeCodeJson: string): void {
  process.stdout.write('## Claude Code\n');
  process.stdout.write(
    '# プロジェクト直下の .mcp.json に貼るか、claude mcp add-json で登録してください。\n\n',
  );
  process.stdout.write(`${claudeCodeJson}\n\n`);
}

function writeCodexSection(codexAddCommand: string, codexConfigToml: string): void {
  process.stdout.write('## Codex\n');
  process.stdout.write(
    '# 次のコマンドを実行すると $CODEX_HOME/config.toml (既定 ~/.codex/config.toml) が更新されます。\n',
  );
  process.stdout.write(`${codexAddCommand}\n\n`);
  process.stdout.write(
    '# または ~/.codex/config.toml に次のブロックを追記してください。\n\n',
  );
  process.stdout.write(codexConfigToml);
  process.stdout.write('\n');
}

function writeCursorSection(cursorJson: string): void {
  process.stdout.write('## Cursor\n');
  process.stdout.write(
    '# プロジェクトの .cursor/mcp.json か ~/.cursor/mcp.json に貼ってください。\n\n',
  );
  process.stdout.write(`${cursorJson}\n\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    printHelp();
    return;
  }

  const serverEntryPath = fileURLToPath(
    new URL('./bd-mcp-server-main.ts', import.meta.url),
  );
  const repoRoot = path.resolve(path.dirname(serverEntryPath), '../../..');
  const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

  if (!existsSync(tsxCliPath)) {
    process.stderr.write(
      `warning: tsx CLI not found at ${tsxCliPath}; generated command may fail until dependencies are installed\n`,
    );
  }

  const configs = buildMcpClientConfigs({
    serverName: parsed.serverName,
    nodeExecPath: process.execPath,
    tsxCliPath,
    serverEntryPath,
    projectRootPath: parsed.projectRootPath,
    bdPath: parsed.bdPath,
  });

  writeNotice();

  if (parsed.target === 'all' || parsed.target === 'claude') {
    writeClaudeSection(configs.claudeCodeJson);
  }
  if (parsed.target === 'all' || parsed.target === 'codex') {
    writeCodexSection(configs.codexAddCommand, configs.codexConfigToml);
  }
  if (parsed.target === 'all' || parsed.target === 'cursor') {
    writeCursorSection(configs.cursorJson);
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
