import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_FILENAME,
  PROVENANCE_SIGNATURE_ALGORITHM,
  PROVENANCE_VERSION,
  parseProvenance,
  provenanceSigningInput,
  serializeProvenance,
} from './provenance';
import type { ProvenanceDocument } from './provenance';

const DIGEST_A = 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';
const DIGEST_B = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
const SIGNATURE = `${'A'.repeat(86)}==`;

/** A minimal valid sidecar, as a plain object so tests can perturb one field. */
const validDocument = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    provenanceVersion: PROVENANCE_VERSION,
    subject: {
      id: 'com.example.app',
      version: '1.0.0',
      files: { 'index.html': DIGEST_A, 'openmini.json': DIGEST_B },
    },
    ...overrides,
  });

const parseOk = (raw: string): ProvenanceDocument => {
  const result = parseProvenance(raw);
  if (!result.ok) {
    throw new Error(`expected a valid document, got: ${result.reason}`);
  }
  return result.document;
};

const reasonFor = (raw: string): string => {
  const result = parseProvenance(raw);
  if (result.ok) {
    throw new Error('expected parsing to fail, but it succeeded');
  }
  return result.reason;
};

describe('parseProvenance', () => {
  it('accepts a well-formed unsigned sidecar', () => {
    const document = parseOk(validDocument());
    expect(document.subject.id).toBe('com.example.app');
    expect(document.subject.files['index.html']).toBe(DIGEST_A);
    // Unsigned is a valid state, and it must be distinguishable from signed:
    // "it parsed" is not "someone vouched for it".
    expect(document.signature).toBeUndefined();
  });

  it('accepts a signed sidecar', () => {
    const document = parseOk(
      validDocument({
        signature: {
          algorithm: PROVENANCE_SIGNATURE_ALGORITHM,
          keyId: 'abc-_123',
          value: SIGNATURE,
        },
      }),
    );
    expect(document.signature?.keyId).toBe('abc-_123');
  });

  it('reports malformed JSON as a parse failure, not a throw', () => {
    expect(reasonFor('{not json')).toMatch(/invalid JSON/);
  });

  it('rejects a JSON array, which is an object to typeof', () => {
    expect(reasonFor('[]')).toMatch(/must be a JSON object/);
  });

  it('rejects an unknown provenanceVersion rather than reading what it recognizes', () => {
    // Fail-closed forward compatibility: a v2 document may restrict something
    // this build does not know to enforce, so partial understanding is worse
    // than refusal.
    expect(reasonFor(validDocument({ provenanceVersion: 2 }))).toMatch(
      /unsupported provenanceVersion/,
    );
  });

  it('rejects a version that is the right number as a string', () => {
    expect(reasonFor(validDocument({ provenanceVersion: '1' }))).toMatch(
      /unsupported provenanceVersion/,
    );
  });

  it('rejects unknown top-level fields', () => {
    expect(reasonFor(validDocument({ extra: true }))).toMatch(/unknown field\(s\): extra/);
  });

  it('rejects unknown subject fields', () => {
    const raw = JSON.stringify({
      provenanceVersion: PROVENANCE_VERSION,
      subject: { id: 'a', version: '1.0.0', files: { 'a.html': DIGEST_A }, note: 'hi' },
    });
    expect(reasonFor(raw)).toMatch(/subject has unknown field\(s\): note/);
  });

  it('rejects an empty file map', () => {
    const raw = JSON.stringify({
      provenanceVersion: PROVENANCE_VERSION,
      subject: { id: 'a', version: '1.0.0', files: {} },
    });
    // Otherwise a signable sidecar could vouch for nothing and still satisfy
    // a check phrased as "every listed file matches".
    expect(reasonFor(raw)).toMatch(/at least one file/);
  });

  it.each([
    ['../escape.html', /relative path segment/],
    ['./same.html', /relative path segment/],
    ['/absolute.html', /absolute path/],
    ['C:/windows.html', /drive-letter path/],
    ['dir\\file.html', /backslash in path/],
    ['dir//file.html', /empty path segment/],
    ['', /empty path/],
  ])('rejects the file path %j', (path, expected) => {
    const raw = JSON.stringify({
      provenanceVersion: PROVENANCE_VERSION,
      subject: { id: 'a', version: '1.0.0', files: { [path]: DIGEST_A } },
    });
    expect(reasonFor(raw)).toMatch(expected);
  });

  it.each([
    ['bare base64 with no algorithm prefix', DIGEST_A.slice('sha256-'.length)],
    ['a different algorithm prefix', DIGEST_A.replace('sha256-', 'sha512-')],
    ['a truncated digest', 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD='],
    ['non-base64 characters', `sha256-${'*'.repeat(43)}=`],
  ])('rejects %s', (_label, digest) => {
    const raw = JSON.stringify({
      provenanceVersion: PROVENANCE_VERSION,
      subject: { id: 'a', version: '1.0.0', files: { 'a.html': digest } },
    });
    expect(reasonFor(raw)).toMatch(/must be a "sha256-<base64>" digest/);
  });

  it('rejects a signature algorithm other than ed25519', () => {
    // Algorithm agility is a downgrade surface; the format admits exactly one.
    const raw = validDocument({
      signature: { algorithm: 'rsa-pss', keyId: 'k', value: SIGNATURE },
    });
    expect(reasonFor(raw)).toMatch(/signature.algorithm must be "ed25519"/);
  });

  it('rejects a signature that is not 64 bytes', () => {
    const raw = validDocument({
      signature: { algorithm: PROVENANCE_SIGNATURE_ALGORITHM, keyId: 'k', value: 'AAAA' },
    });
    expect(reasonFor(raw)).toMatch(/exactly 64 bytes/);
  });

  it('rejects a keyId that is standard base64 rather than base64url', () => {
    // `+` and `/` would have to be escaped everywhere a keyId is shown; the
    // producer emits base64url, so a padded/standard one means a mismatch.
    const raw = validDocument({
      signature: { algorithm: PROVENANCE_SIGNATURE_ALGORITHM, keyId: 'a+b/c=', value: SIGNATURE },
    });
    expect(reasonFor(raw)).toMatch(/base64url/);
  });

  it('rejects unknown signature fields', () => {
    const raw = validDocument({
      signature: {
        algorithm: PROVENANCE_SIGNATURE_ALGORITHM,
        keyId: 'k',
        value: SIGNATURE,
        expires: '2030-01-01',
      },
    });
    // An ignored `expires` is an expired signature honoured forever.
    expect(reasonFor(raw)).toMatch(/signature has unknown field\(s\): expires/);
  });

  it('keeps the last value for a duplicated JSON key, which the signing input then covers', () => {
    // JSON.parse cannot report duplicates, so the format does not pretend to
    // detect them. What matters is that the value the verifier acts on is the
    // value the signature covers — both come from the same parse.
    const raw =
      '{"provenanceVersion":1,"subject":{"id":"a","version":"1.0.0",' +
      `"files":{"a.html":"${DIGEST_A}","a.html":"${DIGEST_B}"}}}`;
    const document = parseOk(raw);
    expect(document.subject.files['a.html']).toBe(DIGEST_B);
    expect(new TextDecoder().decode(provenanceSigningInput(document.subject))).toContain(DIGEST_B);
  });
});

describe('provenanceSigningInput', () => {
  const subject = {
    id: 'com.example.app',
    version: '1.0.0',
    files: { 'index.html': DIGEST_A, 'openmini.json': DIGEST_B },
  };

  it('is byte-identical regardless of the sidecar text it was parsed from', () => {
    // The whole reason the signature covers a canonical form: reformatting a
    // sidecar must not invalidate a signature over a package nobody touched.
    const compact = validDocument();
    const pretty = JSON.stringify(JSON.parse(compact), null, 4);
    expect(provenanceSigningInput(parseOk(pretty).subject)).toEqual(
      provenanceSigningInput(parseOk(compact).subject),
    );
  });

  it('does not depend on the insertion order of the file map', () => {
    const reversed = {
      ...subject,
      files: { 'openmini.json': DIGEST_B, 'index.html': DIGEST_A },
    };
    expect(provenanceSigningInput(reversed)).toEqual(provenanceSigningInput(subject));
  });

  it('carries a version-tagged domain separation prefix', () => {
    // Without it, a signature over this canonical JSON could be replayed as a
    // signature over any other format that accepts the same bytes.
    const text = new TextDecoder().decode(provenanceSigningInput(subject));
    expect(text.startsWith('openmini-provenance-v1\n')).toBe(true);
  });

  it('pins the exact canonical encoding', () => {
    // A literal expectation, not a re-derivation: this string is a wire
    // format. If a change to the canonicalizer alters it, every previously
    // signed package stops verifying, and that must be a loud test failure
    // rather than a silently self-consistent new encoding.
    expect(new TextDecoder().decode(provenanceSigningInput(subject))).toBe(
      'openmini-provenance-v1\n' +
        `{"files":{"index.html":"${DIGEST_A}","openmini.json":"${DIGEST_B}"},` +
        '"id":"com.example.app","version":"1.0.0"}',
    );
  });

  it('distinguishes a different package id with the same files', () => {
    // The transplant case: identical bytes, different claimed identity.
    expect(provenanceSigningInput({ ...subject, id: 'com.example.other' })).not.toEqual(
      provenanceSigningInput(subject),
    );
  });

  it('distinguishes a different version with the same files', () => {
    expect(provenanceSigningInput({ ...subject, version: '1.0.1' })).not.toEqual(
      provenanceSigningInput(subject),
    );
  });

  it('distinguishes a changed digest', () => {
    expect(
      provenanceSigningInput({ ...subject, files: { ...subject.files, 'index.html': DIGEST_B } }),
    ).not.toEqual(provenanceSigningInput(subject));
  });

  it('does not let a path/digest boundary be shifted between entries', () => {
    // A naive `path + digest` concatenation would give these two subjects the
    // same signing input. JSON quoting keeps the fields delimited.
    const a = { id: 'x', version: '1.0.0', files: { ab: DIGEST_A, c: DIGEST_B } };
    const b = { id: 'x', version: '1.0.0', files: { a: DIGEST_A, bc: DIGEST_B } };
    expect(provenanceSigningInput(a)).not.toEqual(provenanceSigningInput(b));
  });
});

describe('serializeProvenance', () => {
  const document: ProvenanceDocument = {
    provenanceVersion: PROVENANCE_VERSION,
    subject: {
      id: 'com.example.app',
      version: '1.0.0',
      files: { 'openmini.json': DIGEST_B, 'index.html': DIGEST_A },
    },
  };

  it('round-trips through the parser', () => {
    expect(parseOk(serializeProvenance(document))).toEqual(document);
  });

  it('sorts the file map so a rebuild is byte-identical', () => {
    // The build is required to be deterministic; insertion order is not.
    const text = serializeProvenance(document);
    expect(text.indexOf('index.html')).toBeLessThan(text.indexOf('openmini.json'));
  });

  it('ends with exactly one newline', () => {
    expect(serializeProvenance(document).endsWith('}\n')).toBe(true);
  });

  it('round-trips a signature', () => {
    const signed: ProvenanceDocument = {
      ...document,
      signature: { algorithm: PROVENANCE_SIGNATURE_ALGORITHM, keyId: 'kid', value: SIGNATURE },
    };
    expect(parseOk(serializeProvenance(signed))).toEqual(signed);
  });

  it('produces text whose signing input matches the in-memory document', () => {
    expect(provenanceSigningInput(parseOk(serializeProvenance(document)).subject)).toEqual(
      provenanceSigningInput(document.subject),
    );
  });
});

describe('PROVENANCE_FILENAME', () => {
  it('is a package-root sibling of the manifest', () => {
    expect(PROVENANCE_FILENAME).toBe('openmini.provenance.json');
  });
});
