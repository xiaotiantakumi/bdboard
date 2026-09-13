import fs from 'node:fs';

const specPath = process.argv[2];
if (!specPath) throw new Error('spec path is required');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
if (spec.argsFile) {
  const args = process.argv.slice(3);
  fs.writeFileSync(spec.argsFile, args.length > 0 ? `${args.join('\n')}\n` : '');
}

// process.exit() は Windows の pipe で stdout/stderr を切り詰めることがある。
process.stdout.write(spec.stdout ?? '');
process.stderr.write(spec.stderr ?? '');
process.exitCode = Number.isInteger(spec.exitCode) ? spec.exitCode : 0;
