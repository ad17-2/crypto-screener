export function parseNumberFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid value for ${flag}: "${raw}"`);
  }
  return parsed;
}

/** Runs `main` (and sets its exit code) only when invoked directly, not when imported (e.g. by a test). */
export function runIfMain(moduleUrl: string, main: () => Promise<number>): void {
  const isMainModule = moduleUrl === `file://${process.argv[1]}`;
  if (isMainModule) {
    main().then((code) => {
      process.exitCode = code;
    });
  }
}
