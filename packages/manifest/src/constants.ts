export const SUPPORTED_SCHEMA_VERSION = 1 as const;

export const MANIFEST_PERMISSIONS = ['storage', 'navigation', 'user', 'network'] as const;

/**
 * A declarable `network.domains` entry: an exact, already-canonical host.
 *
 * Lowercase-only and bracketed-IPv6 are both deliberate. The runtime matches
 * a declared entry against `new URL(...).hostname`, which the WHATWG URL
 * parser always returns lowercased and — for IPv6 — bracketed (`[::1]`, not
 * `::1`). Accepting any other spelling here would produce an entry that can
 * never match anything, i.e. a permission that silently grants nothing.
 */
export const NETWORK_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export const NETWORK_DOMAIN_IPV6_PATTERN = /^\[[0-9a-f:]+\]$/;

export const MAX_NAME_LENGTH = 100;

/**
 * Lowercase reverse-domain-style id: at least two dot-separated segments,
 * each starting with a lowercase letter, made of lowercase letters/digits/
 * hyphens, and never ending with a hyphen.
 */
export const ID_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?(\.[a-z]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Official Semantic Versioning 2.0.0 regex, from https://semver.org.
 */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Requires "://" (not just ":") so a Windows drive letter like "C:\" or "C:/"
// is never mistaken for a URL scheme.
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;

export const ENTRY_PATH_PATTERNS = {
  urlScheme: URL_SCHEME_PATTERN,
  windowsAbsolute: WINDOWS_ABSOLUTE_PATTERN,
};
