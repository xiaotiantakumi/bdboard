export function parseLsofOutput(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | undefined;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number.parseInt(line.slice(1), 10);
      continue;
    }

    if (line.startsWith('n') && currentPid !== undefined) {
      map.set(currentPid, line.slice(1));
      currentPid = undefined;
    }
  }

  return map;
}
