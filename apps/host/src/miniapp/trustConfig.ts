import { trustStoreFromConfig } from '@openmini/runtime';
import type { PackageTrustStore } from '@openmini/runtime';
import { formatTrustConfigIssues, parseTrustConfig, TRUST_CONFIG_FILENAME } from '@openmini/shared';

/**
 * The host's trust configuration, read at startup from a real file.
 *
 * Before Phase 11 this was a generated TypeScript module compiled into the
 * bundle, which meant registering an id required editing source and
 * rebuilding — in direct tension with the project's self-hosted-first
 * premise. It is now `openmini.trust.json`, served beside the app and owned
 * by whoever runs the host.
 *
 * No validation lives here. `@openmini/shared`'s parser decides whether the
 * file is acceptable and its formatter renders the issues, so this host and
 * `openmini trust validate` say the same thing about the same file. A second
 * implementation would be a second set of rules.
 */

export type TrustConfigState =
  | { status: 'loading' }
  | { status: 'ready'; source: string; trustStore: PackageTrustStore; registeredIds: number }
  /**
   * Missing, unreachable, or rejected by the validator.
   *
   * There is deliberately no fourth state in which the host carries on with
   * an empty trust store. An empty store registers no ids, so nothing fails
   * closed and an impostor of a registered id loads as merely unverified —
   * fail-open wearing the word "empty", and strictly worse than the
   * pre-Phase-9 behaviour because the operator believes trust is configured.
   * The load-by-URL path is refused outright instead, and the reason is
   * shown rather than logged.
   */
  | { status: 'unavailable'; source: string; reason: string };

/**
 * Where the configuration is read from.
 *
 * An allowlist rather than a free parameter, for the same reason
 * `?scenario=` is one: it exists so the Playwright specs can drive the
 * host's real startup path through the real app, and a query string that
 * could name any URL would turn a demo host into a fetch proxy.
 */
export const TRUST_CONFIG_SOURCES = {
  default: `/${TRUST_CONFIG_FILENAME}`,
  /** Nothing is served here; the host must refuse rather than default. */
  missing: '/openmini.trust.absent.json',
  /** Written by the fixture generator, deliberately unparseable. */
  invalid: '/openmini.trust.invalid.json',
} as const;

export type TrustConfigSourceName = keyof typeof TRUST_CONFIG_SOURCES;

export function readTrustConfigSource(search: string): string {
  const requested = new URLSearchParams(search).get('trust') ?? 'default';
  return TRUST_CONFIG_SOURCES[requested as TrustConfigSourceName] ?? TRUST_CONFIG_SOURCES.default;
}

/**
 * Fetches and validates the configuration at `source`.
 *
 * Every failure lands in `unavailable`, with a reason an operator can act
 * on. The three that differ are worth keeping apart: a file that is not
 * there needs writing, one that could not be fetched needs the server
 * looking at, and one that was fetched and rejected needs editing — and the
 * last prints the validator's own issue list, unmodified.
 */
export async function loadTrustConfig(source: string): Promise<TrustConfigState> {
  let response: Response;
  try {
    response = await fetch(source, { headers: { Accept: 'application/json' } });
  } catch {
    return {
      status: 'unavailable',
      source,
      reason: `could not fetch ${source}`,
    };
  }

  if (!response.ok) {
    return {
      status: 'unavailable',
      source,
      reason: `${source} is missing (${response.status}). Write one, or point this host at an existing trust configuration.`,
    };
  }

  const raw = await response.text();
  const parsed = parseTrustConfig(raw);
  if (!parsed.valid) {
    return {
      status: 'unavailable',
      source,
      reason: `${source}:\n${formatTrustConfigIssues(parsed.issues)}`,
    };
  }

  return {
    status: 'ready',
    source,
    trustStore: trustStoreFromConfig(parsed.config),
    registeredIds: Object.keys(parsed.config.packages).length,
  };
}
