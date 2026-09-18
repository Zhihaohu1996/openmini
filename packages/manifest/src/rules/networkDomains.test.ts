import { describe, expect, it } from 'vitest';
import { checkNetwork } from './networkDomains';

const WITH_NETWORK = ['network'];
const WITHOUT_NETWORK = ['storage'];

describe('checkNetwork', () => {
  it('accepts an absent declaration when the permission is not requested', () => {
    expect(checkNetwork(undefined, 'network', WITHOUT_NETWORK)).toEqual([]);
  });

  it('accepts valid hostnames when the permission is requested', () => {
    expect(
      checkNetwork(
        { domains: ['api.example.com', 'localhost', '127.0.0.1', '[::1]'] },
        'network',
        WITH_NETWORK,
      ),
    ).toEqual([]);
  });

  it('rejects the permission without a declaration', () => {
    expect(checkNetwork(undefined, 'network', WITH_NETWORK)).toEqual([
      {
        path: 'network',
        code: 'MISSING_NETWORK_DECLARATION',
        message: 'is required when "permissions" includes "network"',
      },
    ]);
  });

  it('rejects a declaration without the permission', () => {
    expect(checkNetwork({ domains: ['api.example.com'] }, 'network', WITHOUT_NETWORK)).toEqual([
      {
        path: 'network',
        code: 'UNEXPECTED_NETWORK_DECLARATION',
        message: 'is only allowed when "permissions" includes "network"',
      },
    ]);
  });

  it('rejects a non-object declaration', () => {
    expect(checkNetwork(['api.example.com'], 'network', WITH_NETWORK)).toEqual([
      { path: 'network', code: 'INVALID_TYPE', message: 'must be an object' },
    ]);
  });

  it('rejects a missing domains field', () => {
    expect(checkNetwork({}, 'network', WITH_NETWORK)).toEqual([
      { path: 'network.domains', code: 'MISSING_FIELD', message: 'is required' },
    ]);
  });

  it('rejects unknown fields alongside domains', () => {
    const issues = checkNetwork({ domains: [], allowAll: true }, 'network', WITH_NETWORK);
    expect(issues).toEqual([
      { path: 'network.allowAll', code: 'UNKNOWN_FIELD', message: 'unknown field' },
    ]);
  });

  it('rejects a non-array domains value', () => {
    expect(checkNetwork({ domains: 'api.example.com' }, 'network', WITH_NETWORK)).toEqual([
      { path: 'network.domains', code: 'INVALID_TYPE', message: 'must be an array' },
    ]);
  });

  it('rejects a non-string domain entry with its index', () => {
    expect(checkNetwork({ domains: ['api.example.com', 42] }, 'network', WITH_NETWORK)).toEqual([
      { path: 'network.domains[1]', code: 'INVALID_TYPE', message: 'must be a string' },
    ]);
  });

  it.each([
    ['https://api.example.com', 'a full URL rather than a hostname'],
    ['api.example.com:8443', 'an embedded port'],
    ['*.example.com', 'a wildcard'],
    ['API.example.com', 'uppercase, which URL.hostname never produces'],
    ['::1', 'an unbracketed IPv6 literal, which URL.hostname never produces'],
    ['api.example.com/v1', 'a path'],
    ['', 'an empty string'],
  ])('rejects %j (%s)', (domain) => {
    const issues = checkNetwork({ domains: [domain] }, 'network', WITH_NETWORK);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: 'network.domains[0]',
      code: 'INVALID_NETWORK_DOMAIN',
    });
  });

  it('rejects a duplicate domain at the repeat index', () => {
    const issues = checkNetwork(
      { domains: ['api.example.com', 'api.example.com'] },
      'network',
      WITH_NETWORK,
    );
    expect(issues).toEqual([
      {
        path: 'network.domains[1]',
        code: 'DUPLICATE_NETWORK_DOMAIN',
        message: 'duplicate domain "api.example.com"',
      },
    ]);
  });
});
