import { describe, expect, it } from 'vitest';
import {
  OPENMINI_MESSAGE_CHANNEL,
  OPENMINI_PROTOCOL_VERSION,
  generateSessionId,
  isOpenMiniEnvelope,
  isValidHandshakeAck,
  isValidHandshakeInitEvent,
} from './messaging';

const validInit = {
  channel: OPENMINI_MESSAGE_CHANNEL,
  version: OPENMINI_PROTOCOL_VERSION,
  sessionId: 'abc-123',
  type: 'handshake-init' as const,
};

describe('isOpenMiniEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isOpenMiniEnvelope(validInit)).toBe(true);
    expect(isOpenMiniEnvelope({ ...validInit, type: 'handshake-ack' })).toBe(true);
  });

  it.each([
    [{ ...validInit, channel: 'not-openmini' }],
    [{ ...validInit, version: 2 }],
    [{ ...validInit, type: 'rpc-call' }],
    [{ ...validInit, sessionId: '' }],
    [{ ...validInit, sessionId: 42 }],
    [null],
    [undefined],
    ['a string'],
    [42],
    [{}],
  ])('rejects malformed value %#', (value) => {
    expect(isOpenMiniEnvelope(value)).toBe(false);
  });
});

describe('isValidHandshakeInitEvent', () => {
  const parentWindow = { marker: 'parent' };
  const otherWindow = { marker: 'other' };
  const onePort = [{ postMessage: () => undefined }];

  it('accepts a well-formed event from the expected source with exactly one port', () => {
    const event = { source: parentWindow, data: validInit, ports: onePort };
    expect(isValidHandshakeInitEvent(event, parentWindow)).toBe(true);
  });

  it('rejects when event.source is not the expected parent (spoofing)', () => {
    const event = { source: otherWindow, data: validInit, ports: onePort };
    expect(isValidHandshakeInitEvent(event, parentWindow)).toBe(false);
  });

  it('rejects when zero ports are transferred', () => {
    const event = { source: parentWindow, data: validInit, ports: [] };
    expect(isValidHandshakeInitEvent(event, parentWindow)).toBe(false);
  });

  it('rejects when more than one port is transferred', () => {
    const event = { source: parentWindow, data: validInit, ports: [...onePort, ...onePort] };
    expect(isValidHandshakeInitEvent(event, parentWindow)).toBe(false);
  });

  it('rejects a malformed envelope even from the correct source', () => {
    const event = { source: parentWindow, data: { foo: 'bar' }, ports: onePort };
    expect(isValidHandshakeInitEvent(event, parentWindow)).toBe(false);
  });

  it('rejects a handshake-ack presented as an init', () => {
    const event = {
      source: parentWindow,
      data: { ...validInit, type: 'handshake-ack' },
      ports: onePort,
    };
    expect(isValidHandshakeInitEvent(event, parentWindow)).toBe(false);
  });
});

describe('isValidHandshakeAck', () => {
  const ack = { ...validInit, type: 'handshake-ack' as const };

  it('accepts a matching sessionId', () => {
    expect(isValidHandshakeAck(ack, 'abc-123')).toBe(true);
  });

  it('rejects a stale/foreign sessionId', () => {
    expect(isValidHandshakeAck(ack, 'different-session')).toBe(false);
  });

  it('rejects a handshake-init presented as an ack', () => {
    expect(isValidHandshakeAck(validInit, 'abc-123')).toBe(false);
  });

  it('rejects a malformed payload', () => {
    expect(isValidHandshakeAck({ not: 'an envelope' }, 'abc-123')).toBe(false);
  });
});

describe('generateSessionId', () => {
  it('produces distinct ids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSessionId()));
    expect(ids.size).toBe(20);
  });

  it('produces a non-empty string', () => {
    expect(typeof generateSessionId()).toBe('string');
    expect(generateSessionId().length).toBeGreaterThan(0);
  });
});
