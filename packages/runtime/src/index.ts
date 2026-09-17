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
export { createFetchResourceProvider, normalizePackageBaseUrl } from './sandbox/fetchResourceProvider';
export { loadMiniAppFromUrl } from './sandbox/loadMiniAppFromUrl';
export type { LoadMiniAppResult } from './sandbox/loadMiniAppFromUrl';
// The CSP/sandbox policy lives in @openmini/shared (pure string logic, no DOM)
// so the Node CLI can generate packages against the exact same definition the
// runtime enforces. Re-exported here so `@openmini/runtime` consumers are
// unaffected.
export { buildMiniAppCsp, MINI_APP_BASE_CSP_DIRECTIVES, MINI_APP_SANDBOX_ATTRIBUTE } from '@openmini/shared';
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

export { createBridgeDispatcher } from './bridge/dispatcher';
export type { BridgeDispatcher, BridgeDispatcherOptions } from './bridge/dispatcher';
export { computePermittedNamespaces, getMethodNamespace, isNamespaceKnown } from './bridge/capabilities';
export {
  BridgeInvalidParamsError,
  BridgeNetworkError,
  BridgePermissionDeniedError,
  BridgeStorageQuotaExceededError,
} from './bridge/errors';
export {
  createStorageHandlers,
  DEFAULT_MAX_KEY_BYTES,
  DEFAULT_MAX_VALUE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES_PER_APP,
} from './bridge/handlers/storage';
export type { StorageHandlerOptions } from './bridge/handlers/storage';
export { createInMemoryStorageProvider } from './bridge/handlers/storageProvider';
export type { MiniAppStorageProvider } from './bridge/handlers/storageProvider';
export { createIndexedDbStorageProvider } from './bridge/handlers/indexedDbStorageProvider';
export { createNavigationHandlers } from './bridge/handlers/navigation';
export {
  createNetworkHandlers,
  isLoopbackHostname,
  NETWORK_MAX_REQUEST_BODY_BYTES,
  NETWORK_MAX_RESPONSE_BODY_BYTES,
  NETWORK_REQUEST_TIMEOUT_MS,
} from './bridge/handlers/network';
export type { NetworkHandlerOptions } from './bridge/handlers/network';
export { createUserHandlers } from './bridge/handlers/user';
export type { StubUserProfile } from './bridge/handlers/user';
export type { BridgeHandlerContext, BridgeMethodHandler, BridgeHandlerRegistry } from './bridge/types';
