import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command, InvalidArgumentError, Option } from 'commander';
import { detectSkillsDrift, syncSkills } from './sync.ts';

async function readVersion(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli/bin.js → ../../package.json
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/*
  Every argParser below rejects with Commander's `InvalidArgumentError`, not a
  plain `Error`. Only that subclass is caught by Commander and turned into a
  usage exit of 2; a plain `Error` escapes `parseAsync` to `bin.ts`, which exits
  1 and misreports a usage error as a runtime failure.
*/
export function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError(`Invalid port: ${value}`);
  }
  return n;
}

interface ServerFlags {
  port?: number;
  host?: string | boolean;
  open?: boolean;
}

interface DevFlags extends ServerFlags {
  skillsCheck?: boolean;
}

async function runSkillsDriftCheck(skillsDir: string): Promise<void> {
  if (process.env.OPEN_SLIDE_SKIP_SKILLS_CHECK === '1') return;

  let drift: Awaited<ReturnType<typeof detectSkillsDrift>>;
  try {
    drift = await detectSkillsDrift(skillsDir);
  } catch {
    return;
  }
  const stale = drift.filter((d) => d.status !== 'unchanged');
  if (stale.length === 0) return;

  const names = stale.map((d) => d.name).join(', ');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!interactive) {
    process.stderr.write(
      `${chalk.yellow('!')} Skills out of date (${names}). Run \`open-slide sync:skills\` to update.\n`,
    );
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        `${chalk.yellow('!')} Skills out of date: ${chalk.bold(names)}. Sync now? ${chalk.dim('(Y/n) ')}`,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') {
      await syncSkills(skillsDir);
    } else {
      process.stdout.write(chalk.dim('Skipped. Run `open-slide sync:skills` later to update.\n'));
    }
  } finally {
    rl.close();
  }
}

interface BuildFlags {
  outDir?: string;
}

interface SyncFlags {
  dryRun?: boolean;
}

interface ExportCliFlags {
  slide?: string;
  all?: boolean;
  page?: number;
  out?: string;
  port?: number;
  timeout?: number;
}

interface VideoCliFlags extends ExportCliFlags {
  fps?: number;
  duration?: number;
  dwell?: number;
  keepFrames?: boolean;
  perPage?: boolean;
}

function parsePositiveInt(label: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new InvalidArgumentError(`Invalid ${label}: ${value}`);
    }
    return n;
  };
}

function parseNonNegativeInt(label: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new InvalidArgumentError(`Invalid ${label}: ${value}`);
    }
    return n;
  };
}

function resolveBuiltinSkillsDir(): string {
  // dist/cli/bin.js → ../../skills (package root + /skills)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'skills');
}

export async function run(argv: string[]): Promise<void> {
  const version = await readVersion();

  const program = new Command();
  program
    .name('open-slide')
    .description('Author slides — we handle the Vite/React stack.')
    .version(version, '-v, --version', 'print version')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError(chalk.dim('(run `open-slide --help` for usage)'))
    /*
      Commander exits 1 on a usage error and the subcommands reserve 1 for
      runtime failure, so every non-zero Commander exit is remapped to 2. Zero
      is left alone: `--help` and `--version` route through the same callback.
      Declared before any `.command()` call because `copyInheritedSettings` snaps
      the callback onto each subcommand at creation time.
    */
    .exitOverride((err) => {
      process.exit(err.exitCode === 0 ? 0 : 2);
    });

  program
    .command('dev')
    .description('Start the dev server')
    .addOption(new Option('-p, --port <port>', 'port to listen on').argParser(parsePort))
    .addOption(new Option('--host [host]', 'expose on the network (optional host)'))
    .option('--open', 'open the browser on start')
    .option('--no-skills-check', 'skip the built-in skills drift check')
    .action(async (flags: DevFlags) => {
      if (flags.skillsCheck !== false) {
        await runSkillsDriftCheck(resolveBuiltinSkillsDir());
      }
      const { dev } = await import('./dev.ts');
      await dev(flags);
    });

  program
    .command('build')
    .description('Build a static site')
    .option('--out-dir <dir>', 'output directory (defaults to `dist`)')
    .action(async (flags: BuildFlags) => {
      const { build } = await import('./build.ts');
      await build(flags);
    });

  program
    .command('preview')
    .description('Preview the production build')
    .addOption(new Option('-p, --port <port>', 'port to listen on').argParser(parsePort))
    .addOption(new Option('--host [host]', 'expose on the network (optional host)'))
    .option('--open', 'open the browser on start')
    .action(async (flags: ServerFlags) => {
      const { preview } = await import('./preview.ts');
      await preview(flags);
    });

  program
    .command('export')
    .description('Render every page of every deck to PNG via headless Chromium')
    .option('--slide <id>', 'restrict export to a single deck')
    .option('--all', 'export every discoverable deck (mutually exclusive with --slide)')
    .addOption(
      new Option('--page <n>', 'export a single 1-based page (requires --slide)').argParser(
        parsePositiveInt('page'),
      ),
    )
    .option('--out <dir>', 'destination directory (defaults to ./png-export)')
    .addOption(
      new Option('--port <port>', 'ephemeral dev-server port override').argParser(parsePort),
    )
    .addOption(
      new Option('--timeout <ms>', 'per-page readiness timeout (default 15000)').argParser(
        parsePositiveInt('timeout'),
      ),
    )
    .addHelpText(
      'after',
      `
Examples:
  $ open-slide export --all                       # every page of every deck to ./png-export
  $ open-slide export --slide intro               # every page of one deck
  $ open-slide export --slide intro --page 2      # a single page of one deck
  $ open-slide export --all --out ./tmp-png       # custom output directory
  $ open-slide export --all --port 5174           # pin the ephemeral dev-server port
  $ open-slide export --all --timeout 30000       # raise per-page readiness timeout to 30s
`,
    )
    .action(async (flags: ExportCliFlags) => {
      const { exportCommand } = await import('./export.ts');
      await exportCommand(flags);
    });

  program
    .command('video')
    .description('Capture a deck as MP4 by seeking its animations frame by frame')
    .option('--slide <id>', 'restrict capture to a single deck')
    .option('--all', 'capture every discoverable deck (mutually exclusive with --slide)')
    .addOption(
      new Option('--page <n>', 'capture a single 1-based page (requires --slide)').argParser(
        parsePositiveInt('page'),
      ),
    )
    .option('--out <dir>', 'destination directory (defaults to ./video-export)')
    .option('--per-page', 'write one MP4 per page instead of one per deck')
    .addOption(
      new Option('--fps <n>', 'frames per second (default 30)').argParser(parsePositiveInt('fps')),
    )
    .addOption(
      new Option(
        '--duration <ms>',
        'override the measured page duration (default: longest finite animation)',
      ).argParser(parsePositiveInt('duration')),
    )
    .addOption(
      new Option('--dwell <ms>', "hold after each page's animation (default 1500)").argParser(
        parseNonNegativeInt('dwell'),
      ),
    )
    .option('--keep-frames', 'keep the intermediate PNG frames instead of deleting them')
    .addOption(
      new Option('--port <port>', 'ephemeral dev-server port override').argParser(parsePort),
    )
    .addOption(
      new Option('--timeout <ms>', 'per-page readiness timeout (default 15000)').argParser(
        parsePositiveInt('timeout'),
      ),
    )
    .addHelpText(
      'after',
      `
Examples:
  $ open-slide video --slide intro                 # one MP4 covering every page of the deck
  $ open-slide video --slide intro --page 2        # a single page
  $ open-slide video --all                         # one MP4 per discoverable deck
  $ open-slide video --all --out ./tmp-video       # custom output directory
  $ open-slide video --all --fps 60                # every deck at 60fps
  $ open-slide video --slide intro --dwell 3000    # hold each page 3s after its animation
  $ open-slide video --slide intro --duration 5000 # force a 5s timeline per page
  $ open-slide video --slide intro --per-page      # one MP4 per page instead of one per deck
  $ open-slide video --slide intro --keep-frames   # keep the PNG frames for inspection
  $ open-slide video --all --port 5174             # pin the ephemeral dev-server port
  $ open-slide video --all --timeout 30000         # raise per-page readiness timeout to 30s

Requires ffmpeg on PATH. Pages animate from CSS keyframes on the wall clock, so
every animation is paused and seeked explicitly — the capture is frame-exact and
reproducible rather than sampled on a timer. Pages are joined by the deck's own
slide transitions, captured from the viewer rather than composed at encode time.

A deck with a step-gated page falls back to one MP4 per page, without --per-page:
a continuous capture cannot advance past a pending step. Each such page is
captured with every step already revealed, so no content is missing, but the
reveal beats and the inter-page transitions are not in the output. Under --all a
mixed workspace therefore produces both shapes in one run, and the summary states
which shape each deck got.
`,
    )
    .action(async (flags: VideoCliFlags) => {
      const { videoCommand } = await import('./video.ts');
      await videoCommand(flags);
    });

  program
    .command('sync:skills')
    .description('Sync built-in skills from @open-slide/core into this workspace')
    .option('--dry-run', 'show what would change without writing')
    .action(async (flags: SyncFlags) => {
      const { syncSkills } = await import('./sync.ts');
      await syncSkills(resolveBuiltinSkillsDir(), flags);
    });

  await program.parseAsync(argv, { from: 'user' });
}
