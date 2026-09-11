export const SUPPORTED_SCHEMA_VERSION = 1 as const;

export const MANIFEST_PERMISSIONS = ['storage', 'navigation', 'user'] as const;

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
