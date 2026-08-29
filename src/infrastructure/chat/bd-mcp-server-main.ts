import { createInterface } from 'node:readline';
import path from 'node:path';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { createBdMcpServer } from './bd-mcp-server.js';

function parseArgs(argv: readonly string[]): {
  readonly projectRootPath?: string;
  readonly bdPath: string;
  readonly gitPath: string;
} {
  let projectRootPath: string | undefined;
  let bdPath = 'bd';
  let gitPath = 'git';

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root' && index + 1 < argv.length) {
      projectRootPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--bd-path' && index + 1 < argv.length) {
      bdPath = argv[index + 1] ?? bdPath;
      index += 1;
      continue;
    }
    if (arg === '--git-path' && index + 1 < argv.length) {
      gitPath = argv[index + 1] ?? gitPath;
      index += 1;
    }
  }

  return { projectRootPath, bdPath, gitPath };
}

async function main(): Promise<void> {
  const { projectRootPath, bdPath, gitPath } = parseArgs(process.argv);

  if (projectRootPath === undefined || !path.isAbsolute(projectRootPath)) {
    process.stderr.write('--project-root must be an absolute path\n');
    process.exit(1);
  }

  const server = createBdMcpServer({
    commandRunner: new NodeCommandRunner(),
    projectRootPath,
    bdPath,
    gitPath,
  });

  const input = createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of input) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const response = await server.handleMessage(message);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
