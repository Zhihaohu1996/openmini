import { buildPackage } from './commands/build.js';
import { startDevServer } from './commands/dev.js';
import { InitError, initProject } from './commands/init.js';
import { generateKeyFile, KeygenError } from './commands/keygen.js';
import { SignError, signPackage } from './commands/sign.js';
import { validatePackage } from './commands/validate.js';
import { verifyPackage } from './commands/verify.js';
import { PackageBuildError } from './packageBuild.js';
import { OPENMINI_CLI_VERSION } from './version.js';

export const USAGE = `openmini ${OPENMINI_CLI_VERSION}

Usage:
  openmini init <dir> --id <app.id> [--name <name>] [--force]
  openmini validate [dir|manifest.json]
  openmini build [dir] [--out <dir>] [--html <path>] [--script <path>]
  openmini dev [dir] [--port <n>]
  openmini keygen --out <keyfile> [--force]
  openmini sign [dir] --key <keyfile>
  openmini verify [dir]

Run "openmini <command> --help" for command-specific usage.

A Mini App package contains only what the runtime loads: openmini.json and
the built entry document. Authoring sources stay in the project directory.

"build" is deterministic and unsigned; "sign" adds a detached
openmini.sig.json afterwards. They are separate because a signature is
randomized and a reproducible build cannot contain one.`;

/** Thrown for anything wrong with the command line itself. Always exit 1. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

interface CommandSpec {
  /** Flags that take a following value. */
  readonly valueFlags: readonly string[];
  /** Flags that stand alone. `help` is added to every command. */
  readonly booleanFlags: readonly string[];
  readonly usage: string;
}

/**
 * The per-command flag allowlist. An unknown flag is an error rather than
 * something silently ignored: a typo'd `--forse` that scaffolds nothing, or a
 * `--ouput` that quietly builds into `dist`, is worse than a failed run.
 *
 * Note that `--version` is deliberately absent. It is honoured only as the
 * very first token (see `run`), so `openmini build --version` is an unknown
 * flag, not a version request.
 */
const COMMAND_SPECS: Record<string, CommandSpec> = {
  init: {
    valueFlags: ['id', 'name'],
    booleanFlags: ['force'],
    usage: `openmini init <dir> --id <app.id> [--name <name>] [--force]

  --id     Reverse-domain Mini App id, e.g. com.example.hello. Required, and
           validated by the same rules "openmini validate" applies.
  --name   Human-readable name. Defaults to the id's last segment.
  --force  Overwrite existing files. Without it, a conflict on any
           destination leaves the directory unchanged.`,
  },
  validate: {
    valueFlags: [],
    booleanFlags: [],
    usage: `openmini validate [dir|manifest.json]

  Validates a package manifest. Exits 0 if valid, 1 otherwise.`,
  },
  build: {
    valueFlags: ['out', 'html', 'script'],
    booleanFlags: [],
    usage: `openmini build [dir] [--out <dir>] [--html <path>] [--script <path>]

  --out     Output package directory, resolved relative to the project and
            required to be inside it. Defaults to "dist".
  --html    Author's HTML shell. Defaults to "src/index.html".
  --script  Entry script. Defaults to "src/main.ts".`,
  },
  dev: {
    valueFlags: ['port'],
    booleanFlags: [],
    usage: `openmini dev [dir] [--port <n>]

  --port  Loopback port, 1-65535. Defaults to an ephemeral port.`,
  },
  keygen: {
    valueFlags: ['out'],
    booleanFlags: ['force'],
    usage: `openmini keygen --out <keyfile> [--force]

  Generates an ECDSA P-256 signing key for "openmini sign".

  --out    Destination key file. Required.
  --force  Overwrite an existing key file. The old key is then
           unrecoverable.

  The key file contains an UNENCRYPTED private key and is written 0600.
  Keep it out of your package directory and out of version control. The
  "publicKey" value in it is what a host puts in its trust store.`,
  },
  sign: {
    valueFlags: ['key'],
    booleanFlags: [],
    usage: `openmini sign [dir] --key <keyfile>

  Signs a built package, writing a detached openmini.sig.json beside its
  openmini.json. Defaults to "dist".

  --key  Key file from "openmini keygen". Required.

  Every file in the package is covered except openmini.sig.json itself.
  Symlinks are refused: a signature must cover bytes the package ships.`,
  },
  verify: {
    valueFlags: [],
    booleanFlags: [],
    usage: `openmini verify [dir]

  Checks a package against its openmini.sig.json: that the signature is
  valid, and that every file on disk matches the digests it covers.
  Defaults to "dist". Exits 0 if verified, 1 otherwise.

  This does NOT decide whether the signing key is trusted. It prints the
  key so you can compare it against a host's trust store.`,
  },
};

const SHORT_ALIASES: Record<string, string> = { h: 'help' };

/** Any `-x` / `--xy` token, when read in flag position. */
function isFlagToken(arg: string): boolean {
  return arg.length > 1 && arg.startsWith('-');
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
  booleans: Set<string>;
}

/**
 * Flag parsing against a command's allowlist.
 *
 * A value may not begin with `--`, so a flag missing its value fails loudly
 * instead of swallowing the next flag. A value *may* begin with a single `-`:
 * `--name -v` names the app "-v", which is odd but is what the author asked
 * for. The bug there was never the parse — it was the old global
 * `argv.includes('-v')` scan reading that value as a version request and
 * exiting 0 without scaffolding anything.
 */
function parseArgs(argv: string[], spec: CommandSpec): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!isFlagToken(arg)) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
    const name = SHORT_ALIASES[raw] ?? raw;

    if (name === 'help' || spec.booleanFlags.includes(name)) {
      booleans.add(name);
      continue;
    }
    if (!spec.valueFlags.includes(name)) {
      throw new CliUsageError(`unknown flag: ${arg}`);
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliUsageError(`flag ${arg} requires a value`);
    }
    flags[name] = next;
    i += 1;
  }

  return { positionals, flags, booleans };
}

function parsePort(raw: string): number {
  // `Number('')`, `Number(' 8080 ')` and `Number('80.5')` are all far too
  // forgiving to hand to a listen() call, so the shape is checked first.
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliUsageError(`--port must be an integer between 1 and 65535 (got "${raw}")`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new CliUsageError(`--port must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

/**
 * Dispatches a command and returns the process exit code.
 *
 * Every command returns its own exit code from here: 0 on success, 1 for a
 * usage error, an invalid package, or a failed build. `cli.ts` remains the
 * last-resort catch for genuinely unexpected throws, not the mechanism by
 * which ordinary failures become non-zero.
 *
 * The one exception is `dev`, which never returns — it holds the process open
 * until interrupted, so there is no exit code to report.
 *
 * Separated from `cli.ts` so the dispatch and its exit codes can be tested
 * directly, without spawning a process.
 */
export async function run(argv: string[]): Promise<number> {
  // Honoured only as the very first token. The old `argv.includes('-v')` scan
  // let a flag *value* hijack the command: `init x --name -v` printed the
  // version and exited 0, having scaffolded nothing.
  const first = argv[0];
  if (first === '--version' || first === '-v') {
    console.log(OPENMINI_CLI_VERSION);
    return 0;
  }

  const [command, ...rest] = argv;
  if (!command) {
    console.log(USAGE);
    return 1;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const spec = COMMAND_SPECS[command];
  if (!spec) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(rest, spec);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`${error.message}\n\n${spec.usage}`);
      return 1;
    }
    throw error;
  }
  const { positionals, flags, booleans } = parsed;

  // Checked after parsing but before any command runs. `--help` is a boolean
  // in every spec, which is what stops `build --help` from throwing
  // "flag --help requires a value" the way it used to.
  if (booleans.has('help')) {
    console.log(spec.usage);
    return 0;
  }

  switch (command) {
    case 'init': {
      const id = flags.id;
      if (!id) {
        console.error('init requires --id <app.id>, e.g. --id com.example.hello');
        return 1;
      }
      try {
        const result = await initProject({
          projectDir: positionals[0] ?? '.',
          id,
          name: flags.name,
          force: booleans.has('force'),
        });
        console.log(`scaffolded ${id} in ${result.projectDir}`);
        for (const file of result.files) {
          console.log(`  ${file}`);
        }
        return 0;
      } catch (error) {
        if (error instanceof InitError) {
          console.error(error.message);
          return 1;
        }
        throw error;
      }
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
      try {
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
      } catch (error) {
        if (error instanceof PackageBuildError) {
          console.error(error.message);
          return 1;
        }
        throw error;
      }
    }

    case 'keygen': {
      const out = flags.out;
      if (!out) {
        console.error('keygen requires --out <keyfile>');
        return 1;
      }
      try {
        const result = await generateKeyFile({ out, force: booleans.has('force') });
        console.log(`wrote signing key to ${result.keyFile}`);
        console.log(`  keyId     ${result.keyId}`);
        console.log(`  publicKey ${result.publicKey}`);
        console.log('');
        console.log('The private key in this file is NOT encrypted. Keep it out of your');
        console.log('package directory and out of version control. Add the publicKey above');
        console.log("to a host's trust store to have it accept packages signed by this key.");
        return 0;
      } catch (error) {
        if (error instanceof KeygenError) {
          console.error(error.message);
          return 1;
        }
        throw error;
      }
    }

    case 'sign': {
      const keyFile = flags.key;
      if (!keyFile) {
        console.error('sign requires --key <keyfile>');
        return 1;
      }
      try {
        const result = await signPackage({ packageDir: positionals[0] ?? 'dist', keyFile });
        console.log(`signed ${result.id} ${result.version} (${result.fileCount} files)`);
        console.log(`  ${result.signatureFile}`);
        console.log(`  keyId ${result.keyId}`);
        return 0;
      } catch (error) {
        if (error instanceof SignError) {
          console.error(error.message);
          return 1;
        }
        throw error;
      }
    }

    case 'verify': {
      const result = await verifyPackage(positionals[0] ?? 'dist');
      if (result.ok) {
        console.log(result.report);
        return 0;
      }
      console.error(result.report);
      return 1;
    }

    case 'dev': {
      let port: number | undefined;
      try {
        port = flags.port === undefined ? undefined : parsePort(flags.port);
      } catch (error) {
        if (error instanceof CliUsageError) {
          console.error(`${error.message}\n\n${spec.usage}`);
          return 1;
        }
        throw error;
      }

      const server = await startDevServer({
        packageDir: positionals[0] ?? 'dist',
        port,
      });
      console.log(`serving on ${server.url} (loopback only)`);
      // Held open until the process is interrupted. Returning a promise that
      // never settles says that honestly; the old `return 0` after an
      // infinite await was unreachable code claiming a successful exit.
      return new Promise<number>(() => undefined);
    }

    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}
