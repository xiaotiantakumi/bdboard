#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsxCliPath = fileURLToPath(import.meta.resolve('tsx/cli'));
const entryPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const child = spawn(
  process.execPath,
  [
    tsxCliPath,
    '--env-file-if-exists=.env',
    entryPath,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

const signalHandlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => {
    child.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

const removeSignalHandlers = () => {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
};

child.once('error', (error) => {
  removeSignalHandlers();
  console.error(`Failed to start bdboard: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  removeSignalHandlers();
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
