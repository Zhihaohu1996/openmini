import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
} from '@openmini/shared';
import type { SigningKeyPair } from '@openmini/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFetchResourceProvider } from './fetchResourceProvider';
import { verifyPackage } from './packageVerification';
import type { PackageTrustStore } from './packageVerification';

/**
 * Phase 13 W4. Signature coverage over the real chain.
 *
 * W2's unit tests hand `createFetchResourceProvider` a digest table written
 * as a literal, which proves the provider's gate and nothing about the table
 * the load path actually gives it. That table is produced by the verifier:
 * `verifyPackage` returns the signed payload's `files` map as `digests`, and
 * `loadMiniAppFromUrl` passes it straight to the provider. Whether a prototype
 * name is refused on the real path is a property of that whole hand-off.
 *
 * So everything here runs: real P-256 key material → a real signature over
 * real manifest bytes → `verifyPackage` → `createFetchResourceProvider` with
 * the digests it returned → `readText`. No digest table is written by hand.
 * The only mock is `fetch`, and it is the assertion: the guarantee is that a
 * file the signature does not cover is refused *before* it is requested, so
 * the spy not being called is the claim and the message is secondary.
 *
 * On this chain the hole has two closures, and either one alone holds it.
 * W1 gives the payload map a null prototype, so the verifier never hands the
 * provider a table with inherited members; W2 gates the provider's lookup,
 * so it would not read them if it were. These refusals therefore fail only
 * when both are gone — confirmed against the pre-phase tree, where every
 * one fails on the spy — and pass against the pre-W2 tree, because W1
 * already covered the table the verifier builds. The provider's gate on its
 * own is W2's unit tests' to prove, over tables a caller supplies.
 *
 * No production code accompanies this file. See docs/plans/phase-13.md, W4.
 */

const BASE_URL = 'https://cdn.example.com/apps/demo/';
const APP_ID = 'com.example.demo';
const APP_VERSION = '1.0.0';
const ENTRY_BODY = '<!doctype html><title>demo</title>';
const PROTO_BODY = 'a file honestly named __proto__';

const MANIFEST_BYTES = new TextEncoder().encode(
  JSON.stringify({
    schemaVersion: 1,
    id: APP_ID,
    name: 'Demo',
    version: APP_VERSION,
    entry: 'index.html',
    permissions: [],
  }),
);

const INHERITED = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

let publisher: SigningKeyPair;
let stranger: SigningKeyPair;

beforeAll(async () => {
  publisher = await generateSigningKeyPair();
  stranger = await generateSigningKeyPair();
});

const digestOf = (text: string): Promise<string> => sha256Base64(new TextEncoder().encode(text));

/**
 * The files a package signs. `extraProtoFile` adds an entry literally named
 * `__proto__`, which cannot be written in an object literal: there a
 * `__proto__:` key — quoted or not — is the prototype-setter form and never
 * becomes an own property, so the fixture would silently not contain it.
 * Assigning onto a null-prototype object has no inherited setter to reach.
 */
async function signedFiles(extraProtoFile = false): Promise<Record<string, string>> {
  const files = Object.create(null) as Record<string, string>;
  files['openmini.json'] = await sha256Base64(MANIFEST_BYTES);
  files['index.html'] = await digestOf(ENTRY_BODY);
  if (extraProtoFile) files['__proto__'] = await digestOf(PROTO_BODY);
  return files;
}

async function signatureBy(key: SigningKeyPair, extraProtoFile = false): Promise<string> {
  const envelope = await signIntegrityPayload(
    {
      payloadVersion: INTEGRITY_PAYLOAD_VERSION,
      id: APP_ID,
      version: APP_VERSION,
      files: await signedFiles(extraProtoFile),
    },
    key.privateKey,
    key.publicKeySpki,
  );
  return serializeSignatureEnvelope(envelope);
}

const trustStore = (): PackageTrustStore => ({
  [APP_ID]: [bytesToBase64(publisher.publicKeySpki)],
});

/**
 * Serves each file by name, with a fresh streaming body per request — the
 * path a real fetch body takes. Any name it does not know is served too:
 * whether such a request happens at all is what is under test, so the server
 * must not be the thing that refuses it.
 */
function packageServer() {
  return vi.fn((input: URL | string) => {
    const name = decodeURIComponent(new URL(input.toString()).pathname.split('/').pop() ?? '');
    const text = name === 'index.html' ? ENTRY_BODY : name === '__proto__' ? PROTO_BODY : 'x';
    const bytes = new TextEncoder().encode(text);
    let done = false;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        }),
      },
    });
  });
}

/** The real chain up to the point a resource is read. */
async function loadVerified(signatureText: string) {
  const verification = await verifyPackage({
    baseUrl: BASE_URL,
    manifestId: APP_ID,
    manifestVersion: APP_VERSION,
    manifestBytes: MANIFEST_BYTES,
    signatureText,
    trustStore: trustStore(),
  });
  if (!verification.ok) throw new Error(`fixture did not verify: ${verification.reason}`);
  return {
    identity: verification.provenance.identity,
    provider: createFetchResourceProvider(BASE_URL, verification.digests),
  };
}

describe('signature coverage over the real chain', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('serves a covered file, so the refusals below are not refusing everything', async () => {
    const server = packageServer();
    global.fetch = server as unknown as typeof fetch;
    const { identity, provider } = await loadVerified(await signatureBy(publisher));

    expect(identity).toMatchObject({ verified: true, id: APP_ID });
    await expect(provider.readText('index.html')).resolves.toBe(ENTRY_BODY);
    expect(server).toHaveBeenCalledTimes(1);
  });

  it('refuses an ordinary file the signature does not mention, without fetching it', async () => {
    // The guarantee as it stood before this phase, on the real chain: the
    // baseline the prototype names below must not fall short of.
    const server = packageServer();
    global.fetch = server as unknown as typeof fetch;
    const { provider } = await loadVerified(await signatureBy(publisher));

    const error = await provider.readText('extra.js').catch((reason: unknown) => reason);

    expect(server).not.toHaveBeenCalled();
    expect((error as Error).message).toMatch(/resource is not covered by the package signature/);
  });

  it.each(INHERITED)(
    'refuses %j, which the signature does not mention, without fetching it',
    async (name) => {
      const server = packageServer();
      global.fetch = server as unknown as typeof fetch;
      const { identity, provider } = await loadVerified(await signatureBy(publisher));
      expect(identity).toMatchObject({ verified: true });

      // Captured rather than asserted inline, so the two claims fail
      // independently: were the refusal bypassed, the request would already
      // be on the wire *and* the message would misreport the reason, and an
      // inline `rejects.toThrow` would only ever report the second.
      const error = await provider.readText(name).catch((reason: unknown) => reason);

      expect(server).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/resource is not covered by the package signature/);
    },
  );

  it('refuses the same way for a package signed by a key nobody registered', async () => {
    // Unverified, but its signature validated, so its digests are still
    // enforced — content integrity and identity are different claims. The
    // coverage refusal belongs to the first, and must not depend on the
    // second.
    const server = packageServer();
    global.fetch = server as unknown as typeof fetch;
    const verification = await verifyPackage({
      baseUrl: BASE_URL,
      manifestId: APP_ID,
      manifestVersion: APP_VERSION,
      manifestBytes: MANIFEST_BYTES,
      signatureText: await signatureBy(stranger),
      trustStore: {},
    });
    if (!verification.ok) throw new Error(verification.reason);
    expect(verification.provenance.identity).toEqual({ verified: false, reason: 'untrusted-key' });
    const provider = createFetchResourceProvider(BASE_URL, verification.digests);

    const error = await provider.readText('constructor').catch((reason: unknown) => reason);

    expect(server).not.toHaveBeenCalled();
    expect((error as Error).message).toMatch(/resource is not covered by the package signature/);
  });

  it('serves a file the signature genuinely lists as __proto__', async () => {
    // The reason this phase gates lookups instead of blocklisting names: a
    // signed package may honestly contain such a file, and must still load.
    // It is also the case on this chain that notices W1 going missing on its
    // own: with W2's gate still in place every refusal above still fires,
    // but the payload parser drops this entry, so an honest file is refused.
    const server = packageServer();
    global.fetch = server as unknown as typeof fetch;
    const { provider } = await loadVerified(await signatureBy(publisher, true));

    await expect(provider.readText('__proto__')).resolves.toBe(PROTO_BODY);
    expect(server).toHaveBeenCalledTimes(1);
  });
});
