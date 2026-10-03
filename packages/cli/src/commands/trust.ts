import { formatTrustConfigIssues, parseTrustConfig, TRUST_CONFIG_FILENAME } from '@openmini/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Checks a host operator's `openmini.trust.json` before a host has to.
 *
 * Adds no validation logic of its own. `@openmini/shared`'s trust-config
 * module is the single source of truth, and its parser and issue formatter
 * are reused verbatim so this command and the host render identical text
 * about identical files — an operator comparing a CLI run against what the
 * host reported should not have to work out whether two wordings mean the
 * same thing. The same call `openmini validate` makes about the manifest
 * parser, for the same reason.
 *
 * Note what this does *not* do, which is the mirror of the note on
 * `openmini verify`. That command checks a package against its signature and
 * declines to say whether the key should be trusted; this one checks the
 * file where that trust is declared and declines to say whether the keys in
 * it are the right ones. A config listing an attacker's key validates here
 * exactly as a correct one does. Only the operator knows which key belongs
 * to which publisher, and nothing in the file can assert it for them.
 */

export interface TrustValidateResult {
  ok: boolean;
  /** Human-readable report, already formatted for printing. */
  report: string;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Validates the trust configuration at `target`.
 *
 * `target` is a directory containing `openmini.trust.json`, or a path to the
 * file itself — the same `.json` convention `openmini validate` uses, so the
 * two commands accept arguments the same way.
 */
export async function validateTrustConfigFile(target: string): Promise<TrustValidateResult> {
  const path = target.endsWith('.json') ? target : join(target, TRUST_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { ok: false, report: `cannot read trust configuration: ${path}` };
  }

  const result = parseTrustConfig(raw);
  if (!result.valid) {
    return { ok: false, report: `${path}:\n${formatTrustConfigIssues(result.issues)}` };
  }

  // Sorted, so two runs over one file print the same thing and a diff
  // between two configs is readable. JSON key order is the author's typing
  // order, which is not a property worth preserving in a report.
  const ids = Object.keys(result.config.packages).sort();
  const lines: string[] = [];
  let totalKeys = 0;

  for (const id of ids) {
    const keys = result.config.packages[id]?.keys ?? [];
    const active = keys.filter((key) => key.status === 'active').length;
    const revoked = keys.length - active;
    totalKeys += keys.length;

    // An id with nothing that may sign it is the case worth spelling out
    // rather than printing as "0 active". It is still registered —
    // registration is the presence of the id — so a package claiming it
    // fails closed rather than falling back to the unregistered path. An
    // operator who revoked a key and expected the app to keep loading should
    // read why it does not here, not in a host's error.
    if (active === 0) {
      lines.push(`  ${id}: registered, but nothing may currently sign it (${revoked} revoked)`);
      continue;
    }
    lines.push(
      revoked === 0
        ? `  ${id}: ${plural(active, 'active key', 'active keys')}`
        : `  ${id}: ${plural(active, 'active key', 'active keys')}, ${revoked} revoked`,
    );
  }

  return {
    ok: true,
    report: [
      `${path}: valid (${plural(ids.length, 'package', 'packages')}, ${plural(totalKeys, 'key', 'keys')})`,
      ...lines,
      '',
      'This checks the shape of the file, NOT whether the keys in it are the',
      'right ones. A key is trusted here because you listed it.',
    ].join('\n'),
  };
}
