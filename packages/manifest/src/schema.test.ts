import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../schema/openmini.schema.json';
import { validateManifest } from './validateManifest';

const ajv = new Ajv2020({ allErrors: true });
const validateAgainstSchema = ajv.compile(schema);

const VALID_MANIFEST = {
  schemaVersion: 1,
  id: 'com.example.restaurant',
  name: 'Example Restaurant',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage'],
};

function without(manifest: Record<string, unknown>, field: string) {
  const copy = { ...manifest };
  delete copy[field];
  return copy;
}

const fixtures: Array<{ name: string; manifest: unknown; expectValid: boolean }> = [
  { name: 'minimal valid manifest', manifest: VALID_MANIFEST, expectValid: true },
  {
    name: 'all four supported permissions',
    manifest: {
      ...VALID_MANIFEST,
      permissions: ['storage', 'navigation', 'user', 'network'],
      network: { domains: ['api.example.com'] },
    },
    expectValid: true,
  },
  {
    name: 'empty permissions',
    manifest: { ...VALID_MANIFEST, permissions: [] },
    expectValid: true,
  },
  {
    name: 'unsupported schemaVersion',
    manifest: { ...VALID_MANIFEST, schemaVersion: 2 },
    expectValid: false,
  },
  { name: 'invalid id', manifest: { ...VALID_MANIFEST, id: 'com' }, expectValid: false },
  { name: 'empty name', manifest: { ...VALID_MANIFEST, name: '' }, expectValid: false },
  { name: 'invalid semver', manifest: { ...VALID_MANIFEST, version: '1.0' }, expectValid: false },
  {
    name: 'absolute filesystem path entry',
    manifest: { ...VALID_MANIFEST, entry: '/etc/x' },
    expectValid: false,
  },
  {
    name: 'root-absolute entry',
    manifest: { ...VALID_MANIFEST, entry: '/index.html' },
    expectValid: false,
  },
  {
    name: 'URL entry',
    manifest: { ...VALID_MANIFEST, entry: 'https://example.com' },
    expectValid: false,
  },
  {
    name: 'path traversal entry',
    manifest: { ...VALID_MANIFEST, entry: '../index.html' },
    expectValid: false,
  },
  {
    name: 'unknown permission',
    manifest: { ...VALID_MANIFEST, permissions: ['camera'] },
    expectValid: false,
  },
  {
    name: 'duplicate permission',
    manifest: { ...VALID_MANIFEST, permissions: ['storage', 'storage'] },
    expectValid: false,
  },
  {
    name: 'unknown top-level field',
    manifest: { ...VALID_MANIFEST, extraField: 'nope' },
    expectValid: false,
  },
  { name: 'missing entry field', manifest: without(VALID_MANIFEST, 'entry'), expectValid: false },
  {
    name: 'network permission with a domains list',
    manifest: {
      ...VALID_MANIFEST,
      permissions: ['network'],
      network: { domains: ['api.example.com', 'localhost', '[::1]'] },
    },
    expectValid: true,
  },
  {
    name: 'invalid network domain',
    manifest: {
      ...VALID_MANIFEST,
      permissions: ['network'],
      network: { domains: ['https://api.example.com'] },
    },
    expectValid: false,
  },
  {
    name: 'unknown field inside network',
    manifest: {
      ...VALID_MANIFEST,
      permissions: ['network'],
      network: { domains: ['api.example.com'], allowAll: true },
    },
    expectValid: false,
  },
];

describe('openmini.schema.json conformance', () => {
  it.each(fixtures)('agrees with validateManifest for $name', ({ manifest, expectValid }) => {
    expect(validateAgainstSchema(manifest)).toBe(expectValid);
    expect(validateManifest(manifest).valid).toBe(expectValid);
  });
});
