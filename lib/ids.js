/**
 * Stable, opaque identifiers.
 *
 * ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. Chosen
 * over UUIDv4 because the string sorts by creation time, which makes on-disk
 * files and audit lines readable without a second timestamp column.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value, length) {
  let out = '';
  let rest = value;
  for (let index = 0; index < length; index += 1) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

export function ulid(now = Date.now()) {
  const bytes = randomBytes(16);
  let tail = '';
  for (let index = 0; index < 16; index += 1) tail += ALPHABET[bytes[index] % 32];
  return encode(now, 10) + tail;
}

/** `per_…`, `obs_…`, `grant_…` — the prefix tells you what a bare id refers to. */
export function id(prefix) {
  return `${prefix}_${ulid()}`;
}
