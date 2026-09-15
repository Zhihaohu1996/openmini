import { describe, expect, it } from 'vitest';
import {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  isBridgeCloseAckEnvelope,
  isBridgeRequestEnvelope,
  isBridgeResponseEnvelope,
} from './protocol';

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const clone: Partial<T> = { ...obj };
  delete clone[key];
  return clone as Omit<T, K>;
}

const request = {
  channel: OPENMINI_BRIDGE_CHANNEL,
  version: OPENMINI_BRIDGE_VERSION,
  sessionId: 'abc-123',
  type: 'request' as const,
  requestId: 'req-1',
  method: 'storage.get',
  params: { key: 'a' },
};

describe('isBridgeRequestEnvelope', () => {
  it('accepts a well-formed request', () => {
    expect(isBridgeRequestEnvelope(request)).toBe(true);
  });

  it.each([
    [{ ...request, channel: 'not-openmini' }],
    [{ ...request, version: 2 }],
    [{ ...request, sessionId: '' }],
    [{ ...request, type: 'response' }],
    [{ ...request, requestId: '' }],
    [{ ...request, method: '' }],
    [omit(request, 'params')],
    [null],
    [undefined],
    ['a string'],
    [{}],
  ])('rejects malformed value %#', (value) => {
    expect(isBridgeRequestEnvelope(value)).toBe(false);
  });
});

describe('isBridgeResponseEnvelope', () => {
  const success = {
    channel: OPENMINI_BRIDGE_CHANNEL,
    version: OPENMINI_BRIDGE_VERSION,
    sessionId: 'abc-123',
    type: 'response' as const,
    requestId: 'req-1',
    ok: true as const,
    result: { value: 'x' },
  };
  const failure = {
    channel: OPENMINI_BRIDGE_CHANNEL,
    version: OPENMINI_BRIDGE_VERSION,
    sessionId: 'abc-123',
    type: 'response' as const,
    requestId: 'req-1',
    ok: false as const,
    error: { code: 'INVALID_PARAMS' as const, message: 'bad params' },
  };

  it('accepts a well-formed success response', () => {
    expect(isBridgeResponseEnvelope(success)).toBe(true);
  });

  it('accepts a well-formed error response', () => {
    expect(isBridgeResponseEnvelope(failure)).toBe(true);
  });

  it('rejects an error response with an unknown error code', () => {
    expect(isBridgeResponseEnvelope({ ...failure, error: { code: 'NOT_A_REAL_CODE', message: 'x' } })).toBe(false);
  });

  it('rejects a success response missing the result field entirely', () => {
    expect(isBridgeResponseEnvelope(omit(success, 'result'))).toBe(false);
  });

  it.each([[{ ...success, sessionId: '' }], [{ ...success, requestId: '' }], [{ ...success, type: 'request' }], [null], [{}]])(
    'rejects malformed value %#',
    (value) => {
      expect(isBridgeResponseEnvelope(value)).toBe(false);
    },
  );
});

describe('isBridgeCloseAckEnvelope', () => {
  const ack = {
    channel: OPENMINI_BRIDGE_CHANNEL,
    version: OPENMINI_BRIDGE_VERSION,
    sessionId: 'abc-123',
    type: 'close-ack' as const,
    requestId: 'req-1',
  };

  it('accepts a well-formed close-ack', () => {
    expect(isBridgeCloseAckEnvelope(ack)).toBe(true);
  });

  it.each([[{ ...ack, requestId: '' }], [{ ...ack, type: 'response' }], [null], [{}]])(
    'rejects malformed value %#',
    (value) => {
      expect(isBridgeCloseAckEnvelope(value)).toBe(false);
    },
  );
});
