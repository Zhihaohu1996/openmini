/**
 * Generic random id generator shared by anything needing a fresh,
 * unpredictable identifier (sandbox session ids, bridge request ids, ...).
 * Prefers crypto.randomUUID(); falls back for environments without it.
 */
export function generateRandomId(): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
