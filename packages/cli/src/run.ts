import { buildPackage } from './commands/build.js';
import { startDevServer } from './commands/dev.js';
import { initProject } from './commands/init.js';
import { validatePackage } from './commands/validate.js';
import { OPENMINI_CLI_VERSION } from './version.js';

export const USAGE = `openmini ${OPENMINI_CLI_VERSION}

Usage:
  openmini init <dir> --id <app.id> [--name <name>]
  openmini validate [dir|manifest.json]
  openmini build [dir] [--out <dir>] [--html <path>] [--script <path>]
  openmini dev [dir] [--port <n>]

A Mini App package contains only what the runtime loads: openmini.json and
the built entry document. Authoring sources stay in the project directory.`;

/** Minimal flag parsing: --key value pairs plus positional arguments. */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`flag --${name} requires a value`);
      }
      flags[name] = next;
      i += 1;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/**
 * Dispatches a command and returns the process exit code.
 *
 * Separated from `cli.ts` so the dispatch and its exit codes can be tested
 * directly, without spawning a process: a non-zero exit on an invalid
 * package or a failed build is part of the contract CI depends on.
 */
export async function run(argv: string[]): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(OPENMINI_CLI_VERSION);
    return 0;
  }

  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case 'init': {
      const id = flags.id;
      if (!id) {
        console.error('init requires --id <app.id>, e.g. --id com.example.hello');
        return 1;
      }
      const result = await initProject({
        projectDir: positionals[0] ?? '.',
        id,
        name: flags.name,
      });
      console.log(`scaffolded ${id} in ${result.projectDir}`);
      for (const file of result.files) {
        console.log(`  ${file}`);
      }
      return 0;
    }

    case 'validate': {
      const result = await validatePackage(positionals[0] ?? '.');
      if (result.ok) {
        console.log(result.report);
        return 0;
      }
      console.error(result.report);
      return 1;
    }

    case 'build': {
      const result = await buildPackage({
        projectDir: positionals[0] ?? '.',
        outDir: flags.out ?? 'dist',
        htmlPath: flags.html,
        scriptPath: flags.script,
      });
      console.log(`built package in ${result.outDir}`);
      console.log(`  ${result.manifestFile}`);
      console.log(`  ${result.entryFile}`);
      return 0;
    }

    case 'dev': {
      const server = await startDevServer({
        packageDir: positionals[0] ?? 'dist',
        port: flags.port ? Number(flags.port) : undefined,
      });
      console.log(`serving on ${server.url} (loopback only)`);
      // Held open until the process is interrupted.
      await new Promise(() => undefined);
      return 0;
    }

    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}
