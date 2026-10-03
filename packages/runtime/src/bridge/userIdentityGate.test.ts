import type { OpenMiniManifest } from '@openmini/manifest';
import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
} from '@openmini/shared';
import type { BridgeResponseEnvelope, SigningKeyPair, UserProfile } from '@openmini/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyPackage } from '../sandbox/packageVerification';
import type { PackageTrustStore } from '../sandbox/packageVerification';
import type { MiniAppSandbox, PackageProvenance, SandboxStateListener } from '../sandbox/types';
import { createBridgeDispatcher } from './dispatcher';
import { createUserHandlers } from './handlers/user';

/**
 * Phase 12 W4. The user-identity gate over the real chain.
 *
 * W3's unit tests decide the policy on hand-built `PackageProvenance`
 * literals, which is the right shape for a decision table and proves
 * nothing about where those values come from. A literal cannot show that
 * the verifier actually produces what the gate reads — if `verifyPackage`
 * stopped setting `identity.verified`, or set it on a path it should not,
 * every one of those tests would still pass.
 *
 * So everything here runs: real P-256 key material → a real signature over
 * real manifest bytes → `verifyPackage` → the real dispatcher over a real
 * `MessageChannel` → the real user handler. No provenance is written by
 * hand. The only constructed value is the host's own profile, which is
 * host data by definition.
 *
 * No production code accompanies this file.
 */

const BASE_URL = 'https://cdn.example.com/apps/notes/';
const REGISTERED_ID = 'com.example.notes';
/** Deliberately absent from every trust store below. */
const UNREGISTERED_ID = 'com.example.unregistered';
const APP_VERSION = '1.0.0';
const ENTRY_DIGEST = 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';

const HOST_PROFILE: UserProfile = { id: 'u_1138', displayName: 'Ada' };
const ANONYMOUS = { id: null, displayName: null };

let publisher: SigningKeyPair;
let successor: SigningKeyPair;
let stranger: SigningKeyPair;

beforeAll(async () => {
  publisher = await generateSigningKeyPair();
  successor = await generateSigningKeyPair();
  stranger = await generateSigningKeyPair();
});

const manifestBytesFor = (id: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Notes',
      version: APP_VERSION,
      entry: 'index.html',
      permissions: ['user'],
    }),
  );

async function signatureFor(key: SigningKeyPair, id: string): Promise<string> {
  const envelope = await signIntegrityPayload(
    {
      payloadVersion: INTEGRITY_PAYLOAD_VERSION,
      id,
      version: APP_VERSION,
      files: {
        'openmini.json': await sha256Base64(manifestBytesFor(id)),
        'index.html': ENTRY_DIGEST,
      },
    },
    key.privateKey,
    key.publicKeySpki,
  );
  return serializeSignatureEnvelope(envelope);
}

const keyed = (key: SigningKeyPair, status: 'active' | 'revoked') => ({
  publicKey: bytesToBase64(key.publicKeySpki),
  status,
});

/**
 * Runs the real verifier and returns the provenance it produced.
 *
 * Fails loudly on a refusal rather than returning undefined: a test that
 * meant to exercise a loaded package must not quietly become a test of the
 * no-provenance path, which has the same expected answer for three of the
 * cases below and would hide the difference.
 */
async function provenanceFrom(options: {
  id: string;
  signer?: SigningKeyPair;
  trustStore?: PackageTrustStore;
}): Promise<PackageProvenance> {
  const { id, signer, trustStore } = options;
  const outcome = await verifyPackage({
    baseUrl: BASE_URL,
    manifestId: id,
    manifestVersion: APP_VERSION,
    manifestBytes: manifestBytesFor(id),
    signatureText: signer ? await signatureFor(signer, id) : undefined,
    trustStore,
  });

  if (!outcome.ok) {
    throw new Error(`expected this package to load, but it was refused: ${outcome.code}`);
  }
  return outcome.provenance;
}

function createFakeSandbox(sessionId = 'session-1'): MiniAppSandbox {
  const listeners = new Set<SandboxStateListener>();
  return {
    state: 'running',
    sessionId,
    start: async () => undefined,
    destroy: vi.fn(() => {
      for (const listener of listeners) listener('destroyed');
    }),
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function manifestFor(id: string, permissions: OpenMiniManifest['permissions']): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'Notes',
    version: APP_VERSION,
    entry: 'index.html',
    permissions,
  };
}

/**
 * Asks `user.getProfile` over a real port, through the real dispatcher,
 * with the real user handler.
 */
async function askForProfile(options: {
  provenance?: PackageProvenance;
  permissions?: OpenMiniManifest['permissions'];
  profile?: UserProfile;
  id?: string;
}): Promise<BridgeResponseEnvelope> {
  const channel = new MessageChannel();
  const received: BridgeResponseEnvelope[] = [];
  channel.port2.onmessage = (event) => received.push(event.data as BridgeResponseEnvelope);

  createBridgeDispatcher({
    manifest: manifestFor(options.id ?? REGISTERED_ID, options.permissions ?? ['user']),
    sandbox: createFakeSandbox(),
    port: channel.port1,
    provenance: options.provenance,
    handlers: { user: createUserHandlers({ profile: options.profile }) },
  });

  channel.port2.postMessage({
    channel: OPENMINI_BRIDGE_CHANNEL,
    version: OPENMINI_BRIDGE_VERSION,
    sessionId: 'session-1',
    type: 'request',
    requestId: 'req-1',
    method: 'user.getProfile',
    params: undefined,
  });
  await tick();
  await tick();

  const response = received[0];
  if (response === undefined) {
    throw new Error('the dispatcher sent no response');
  }
  return response;
}

describe('a verified package, through the whole chain', () => {
  it('receives the host profile', async () => {
    const provenance = await provenanceFrom({
      id: REGISTERED_ID,
      signer: publisher,
      trustStore: { [REGISTERED_ID]: [keyed(publisher, 'active')] },
    });

    // The verifier really did establish an identity -- asserted here so a
    // later failure cannot be blamed on a fixture that was never verified.
    expect(provenance.identity).toMatchObject({ verified: true, id: REGISTERED_ID });

    const response = await askForProfile({ provenance, profile: HOST_PROFILE });

    expect(response).toMatchObject({ ok: true, result: HOST_PROFILE });
  });

  it('receives the anonymous profile when the host named nobody', async () => {
    const provenance = await provenanceFrom({
      id: REGISTERED_ID,
      signer: publisher,
      trustStore: { [REGISTERED_ID]: [keyed(publisher, 'active')] },
    });

    const response = await askForProfile({ provenance });

    expect(response).toMatchObject({ ok: true, result: ANONYMOUS });
  });
});

describe('the two gates stay independent over the real chain', () => {
  it('refuses a verified package that never declared the user permission', async () => {
    // Verified and still refused. The dispatcher's permission gate runs
    // before any handler, so this is a denial rather than a success
    // carrying nulls -- a distinction only a dispatcher-level test can make.
    const provenance = await provenanceFrom({
      id: REGISTERED_ID,
      signer: publisher,
      trustStore: { [REGISTERED_ID]: [keyed(publisher, 'active')] },
    });

    const response = await askForProfile({
      provenance,
      permissions: ['storage'],
      profile: HOST_PROFILE,
    });

    expect(response).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('permits an unverified package to ask, and still tells it nothing', async () => {
    // The mirror: the permission gate passes and the provenance gate does
    // not. A success carrying nulls, not a denial.
    const provenance = await provenanceFrom({ id: UNREGISTERED_ID, signer: stranger });

    expect(provenance.identity).toEqual({ verified: false, reason: 'untrusted-key' });

    const response = await askForProfile({
      provenance,
      id: UNREGISTERED_ID,
      profile: HOST_PROFILE,
    });

    expect(response).toMatchObject({ ok: true, result: ANONYMOUS });
  });
});

describe('an unverified package learns nothing, whatever made it unverified', () => {
  it('withholds from a package the verifier reported as unsigned', async () => {
    const provenance = await provenanceFrom({ id: UNREGISTERED_ID });

    // Produced by the verifier, not written here -- this is the shape a
    // presence-based gate would wrongly admit.
    expect(provenance.identity).toEqual({ verified: false, reason: 'unsigned' });

    const response = await askForProfile({
      provenance,
      id: UNREGISTERED_ID,
      profile: HOST_PROFILE,
    });

    expect(response).toMatchObject({ ok: true, result: ANONYMOUS });
  });

  it('withholds from a package signed by a key no host registered', async () => {
    const provenance = await provenanceFrom({ id: UNREGISTERED_ID, signer: stranger });

    const response = await askForProfile({
      provenance,
      id: UNREGISTERED_ID,
      profile: HOST_PROFILE,
    });

    expect(response).toMatchObject({ ok: true, result: ANONYMOUS });
  });

  it('withholds when no package was loaded at all', async () => {
    const response = await askForProfile({ provenance: undefined, profile: HOST_PROFILE });

    expect(response).toMatchObject({ ok: true, result: ANONYMOUS });
  });

  it('answers all three the same way, down to the bytes on the wire', async () => {
    // Invariant 2, over the real transport rather than over return values.
    // Whatever a Mini App can observe is what arrives here, so this is the
    // level at which "indistinguishable" has to hold.
    const unsignedProvenance = await provenanceFrom({ id: UNREGISTERED_ID });
    const untrustedProvenance = await provenanceFrom({ id: UNREGISTERED_ID, signer: stranger });

    const answers = await Promise.all([
      askForProfile({ provenance: unsignedProvenance, id: UNREGISTERED_ID, profile: HOST_PROFILE }),
      askForProfile({
        provenance: untrustedProvenance,
        id: UNREGISTERED_ID,
        profile: HOST_PROFILE,
      }),
      askForProfile({ provenance: undefined, profile: HOST_PROFILE }),
      // A verified package whose host simply has nobody signed in.
      askForProfile({
        provenance: await provenanceFrom({
          id: REGISTERED_ID,
          signer: publisher,
          trustStore: { [REGISTERED_ID]: [keyed(publisher, 'active')] },
        }),
      }),
    ]);

    const serialized = answers.map((answer) => JSON.stringify(answer));
    expect(new Set(serialized).size).toBe(1);
    expect(answers[0]).toMatchObject({ ok: true, result: ANONYMOUS });
  });
});

describe('the entitlement follows the id, not the key', () => {
  it('is unchanged after rotating to a successor key', async () => {
    // Rotation in the state an operator leaves behind: the retired key
    // retained as `revoked`, the successor active. The same claim Phase 11
    // made for the storage namespace, now for the identity entitlement.
    const rotated: PackageTrustStore = {
      [REGISTERED_ID]: [keyed(publisher, 'revoked'), keyed(successor, 'active')],
    };

    const before = await provenanceFrom({
      id: REGISTERED_ID,
      signer: publisher,
      trustStore: { [REGISTERED_ID]: [keyed(publisher, 'active')] },
    });
    const after = await provenanceFrom({
      id: REGISTERED_ID,
      signer: successor,
      trustStore: rotated,
    });

    // Genuinely a different key, or the assertion below means nothing.
    expect(after.identity).toMatchObject({ verified: true, keyId: successor.keyId });
    expect(before.identity).toMatchObject({ verified: true, keyId: publisher.keyId });
    expect(successor.keyId).not.toBe(publisher.keyId);

    const [profileBefore, profileAfter] = await Promise.all([
      askForProfile({ provenance: before, profile: HOST_PROFILE }),
      askForProfile({ provenance: after, profile: HOST_PROFILE }),
    ]);

    expect(profileAfter).toMatchObject({ ok: true, result: HOST_PROFILE });
    expect(JSON.stringify(profileAfter)).toBe(JSON.stringify(profileBefore));
  });

  it('never reaches the handler for a revoked key, because the load is refused', async () => {
    // The structural reason revocation needs no separate identity rule: a
    // revoked package produces no provenance, so there is nothing to hand
    // the dispatcher. Asserted on the refusal itself rather than by
    // dispatching, because dispatching would require inventing the
    // provenance the verifier declined to produce.
    const outcome = await verifyPackage({
      baseUrl: BASE_URL,
      manifestId: REGISTERED_ID,
      manifestVersion: APP_VERSION,
      manifestBytes: manifestBytesFor(REGISTERED_ID),
      signatureText: await signatureFor(publisher, REGISTERED_ID),
      trustStore: { [REGISTERED_ID]: [keyed(publisher, 'revoked')] },
    });

    expect(outcome).toMatchObject({ ok: false, code: 'revoked-key' });
    expect(outcome).not.toHaveProperty('provenance');
  });
});
