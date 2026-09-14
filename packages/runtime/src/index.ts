import { OPENMINI_SHARED_VERSION } from '@openmini/shared';

export const OPENMINI_RUNTIME_VERSION = '0.1.0';

export function getRuntimeInfo(): { runtimeVersion: string; sharedVersion: string } {
  return {
    runtimeVersion: OPENMINI_RUNTIME_VERSION,
    sharedVersion: OPENMINI_SHARED_VERSION,
  };
}

export { createMiniAppSandbox } from './sandbox/createSandbox';
export type { SandboxRuntimeDeps } from './sandbox/createSandbox';
export { gateManifest } from './sandbox/manifestGate';
export type { ManifestGateResult } from './sandbox/manifestGate';
export { StaticFixtureResourceProvider, resolveEntryDocument } from './sandbox/resourceProvider';
export type { ResolveEntryDocumentResult } from './sandbox/resourceProvider';
export { buildMiniAppCsp, MINI_APP_BASE_CSP_DIRECTIVES, MINI_APP_SANDBOX_ATTRIBUTE } from './sandbox/csp';
export { resolveContainedPath } from './sandbox/containment';
export type { ContainmentFailureReason, ContainmentResult } from './sandbox/containment';
export {
  OPENMINI_MESSAGE_CHANNEL,
  OPENMINI_PROTOCOL_VERSION,
  generateSessionId,
  isOpenMiniEnvelope,
  isValidHandshakeAck,
  isValidHandshakeInitEvent,
} from './sandbox/messaging';
export type { OpenMiniEnvelope, OpenMiniMessageType, BootstrapMessageEventLike } from './sandbox/messaging';
export type {
  MiniAppResourceProvider,
  MiniAppSandbox,
  SandboxErrorCode,
  SandboxErrorInfo,
  SandboxOptions,
  SandboxState,
  SandboxStateListener,
} from './sandbox/types';
