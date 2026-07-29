/**
 * @agents-index Unit tests for the CLI's argument layer — the exported port
 * parser, and the exit code a malformed flag produces after travelling through
 * Commander. The second group exercises `run` rather than the parsers directly,
 * because the parsers alone cannot show what Commander does with what they
 * throw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePort, run } from './run.ts';

describe('parsePort', () => {
  it('accepts valid integer ports', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('80')).toBe(80);
    expect(parsePort('5173')).toBe(5173);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects non-numeric input', () => {
    expect(() => parsePort('abc')).toThrow(/Invalid port/);
    expect(() => parsePort('80x')).toThrow(/Invalid port/);
  });

  it('rejects out-of-range ports', () => {
    expect(() => parsePort('-1')).toThrow(/Invalid port/);
    expect(() => parsePort('65536')).toThrow(/Invalid port/);
    expect(() => parsePort('100000')).toThrow(/Invalid port/);
  });

  it('rejects non-integer numbers', () => {
    expect(() => parsePort('80.5')).toThrow(/Invalid port/);
  });
});

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Parse `argv` through the real program and report the process exit code it
 * asked for.
 *
 * Every argument here is rejected during parsing, so no action handler runs and
 * nothing is launched. Returns `'no-exit'` if parsing completed without asking
 * to exit, and rethrows anything that escaped `parseAsync` — which is what an
 * argParser throwing a plain `Error` does, since Commander only converts its own
 * `InvalidArgumentError` into a usage exit.
 */
async function exitCodeFor(argv: string[]): Promise<number | 'no-exit'> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitSignal(Number(code ?? 0));
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await run(argv);
    return 'no-exit';
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
    stdout.mockRestore();
  }
}

describe('usage exits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['--fps', ['video', '--slide', 'intro', '--fps', '0']],
    ['--page', ['video', '--slide', 'intro', '--page', '0']],
    ['--duration', ['video', '--slide', 'intro', '--duration', '0']],
    ['--dwell', ['video', '--slide', 'intro', '--dwell', '-1']],
    ['--timeout', ['video', '--slide', 'intro', '--timeout', '0']],
    ['--port', ['video', '--slide', 'intro', '--port', '99999']],
  ])('an out-of-range %s exits 2 through the video subcommand', async (_flag, argv) => {
    await expect(exitCodeFor(argv)).resolves.toBe(2);
  });

  it.each([
    ['--page', ['export', '--slide', 'intro', '--page', '0']],
    ['--timeout', ['export', '--slide', 'intro', '--timeout', '0']],
  ])('an out-of-range %s exits 2 through the export subcommand', async (_flag, argv) => {
    await expect(exitCodeFor(argv)).resolves.toBe(2);
  });

  it('an unknown subcommand exits 2', async () => {
    await expect(exitCodeFor(['not-a-command'])).resolves.toBe(2);
  });

  it('--help and --version exit 0', async () => {
    await expect(exitCodeFor(['--help'])).resolves.toBe(0);
    await expect(exitCodeFor(['--version'])).resolves.toBe(0);
    await expect(exitCodeFor(['video', '--help'])).resolves.toBe(0);
  });
});
