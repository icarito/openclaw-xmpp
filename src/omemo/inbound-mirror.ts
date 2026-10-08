// Mirror the encryption of the peer's last direct message: a client without
// OMEMO (e.g. xat) gets plaintext replies, while OMEMO clients keep getting
// encrypted ones. Unknown peers (proactive messages) keep the old behavior:
// encrypt when possible. `requireEncryption` always wins over mirroring.

const lastInboundEncrypted = new Map<string, boolean>();

function key(accountId: string, peerBare: string): string {
  return `${accountId}\u0000${peerBare.toLowerCase()}`;
}

export function noteInboundEncryption(accountId: string, peerBare: string, encrypted: boolean): void {
  lastInboundEncrypted.set(key(accountId, peerBare), encrypted);
}

export function shouldEncryptDirect(
  accountId: string,
  peerBare: string,
  opts: { mirrorInbound?: boolean; requireEncryption?: boolean },
): boolean {
  if (opts.requireEncryption || opts.mirrorInbound === false) return true;
  return lastInboundEncrypted.get(key(accountId, peerBare)) !== false;
}

/** Test helper. */
export function resetInboundEncryption(): void {
  lastInboundEncrypted.clear();
}
