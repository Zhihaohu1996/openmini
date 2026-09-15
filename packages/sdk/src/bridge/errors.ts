import type { BridgeErrorCode } from '@openmini/shared';

/** Thrown/rejected by the bridge client for both host-sent and client-synthesized errors. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}
