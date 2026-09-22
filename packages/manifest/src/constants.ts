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
export const NETWORK_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export const NETWORK_DOMAIN_IPV6_PATTERN = /^\[[0-9a-f:]+\]$/;

export const MAX_NAME_LENGTH = 100;

/**
 * Upper bound on `id`, which `ID_PATTERN` alone does not impose — the
 * pattern is happy with a megabyte of dot-separated segments.
 *
 * `name` has been bounded since Phase 2 and `id` has not, which is the wrong
 * way round: `name` is a label, while `id` is used as a key. It scopes
 * storage, it is bound into a package signature, and it appears in error
 * text and logs. An unbounded value in any of those is a way to consume
 * space or flood a log with one manifest field.
 *
 * 255 is chosen to match `name`'s style of bound — generous enough that no
 * plausible reverse-domain id comes near it, small enough to be a bound.
 */
export const MAX_ID_LENGTH = 255;

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

// Matches a bare "scheme:" prefix, not just "scheme://". A scheme with no
// "//" is still an absolute URL to the WHATWG parser — `https:evil.com` and
// `https:/evil.com` both resolve away from a package base — so accepting them
// as entry paths would declare an entry that lives outside its own package.
// `checkEntryPath` tests windowsAbsolute BEFORE this, so "C:\x" and "C:/x"
// keep their precise "absolute filesystem path" diagnostic rather than
// degrading to the vaguer "must not be a URL".
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;

export const ENTRY_PATH_PATTERNS = {
  urlScheme: URL_SCHEME_PATTERN,
  windowsAbsolute: WINDOWS_ABSOLUTE_PATTERN,
};
