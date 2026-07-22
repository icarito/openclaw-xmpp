/** OMEMO 2 payload cryptography and protobuf wire helpers.
 *
 * XEP-0384 0.9.x deliberately does not use AES-GCM.  The payload key is a
 * random 32-byte value; HKDF-SHA-256 (zero salt, `OMEMO Payload` info) derives
 * AES-256-CBC, HMAC-SHA-256 and IV material.  The HMAC is truncated to 16
 * bytes.  This module contains the small protobuf messages needed on the
 * wire, avoiding a generated runtime dependency.
 */
import crypto from "node:crypto";

const INFO = Buffer.from("OMEMO Payload", "utf8");
const ZERO_SALT = Buffer.alloc(32);

export type V2Payload = { key: Uint8Array; payload: Uint8Array };

function varint(n: number): Buffer {
  const out: number[] = [];
  let x = n >>> 0;
  do { out.push((x & 0x7f) | (x > 0x7f ? 0x80 : 0)); x >>>= 7; } while (x);
  return Buffer.from(out);
}

function bytesField(field: number, value: Uint8Array): Buffer {
  const b = Buffer.from(value);
  return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(b.length), b]);
}

/** Encode OMEMOMessage + OMEMOAuthenticatedMessage (protobuf wire format). */
export function encodeAuthenticatedMessage(ciphertext: Uint8Array, mac: Uint8Array): Uint8Array {
  // n/pn are populated as zero until the Signal implementation exposes the
  // ratchet header. dh_pub is required by the schema and is therefore encoded
  // as an empty bytes field rather than omitted.
  const message = Buffer.concat([
    Buffer.from([0x08, 0x00, 0x10, 0x00]),
    bytesField(3, new Uint8Array()),
    bytesField(4, ciphertext),
  ]);
  return Buffer.concat([bytesField(1, mac), bytesField(2, message)]);
}

function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0; let shift = 0; let i = offset;
  while (i < buf.length && shift < 35) {
    const b = buf[i++]!; value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: value >>> 0, next: i };
    shift += 7;
  }
  throw new Error("invalid OMEMO protobuf varint");
}

function readFields(buf: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>(); let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i); i = tag.next;
    const field = tag.value >>> 3; const wire = tag.value & 7;
    if (wire === 0) { const v = readVarint(buf, i); i = v.next; continue; }
    if (wire !== 2) throw new Error(`unsupported OMEMO protobuf wire type ${wire}`);
    const len = readVarint(buf, i); i = len.next;
    if (i + len.value > buf.length) throw new Error("truncated OMEMO protobuf");
    const value = buf.slice(i, i + len.value); i += len.value;
    const list = fields.get(field) ?? []; list.push(value); fields.set(field, list);
  }
  return fields;
}

export function decodeAuthenticatedMessage(payload: Uint8Array): { ciphertext: Uint8Array; mac: Uint8Array } {
  const outer = readFields(payload);
  const mac = outer.get(1)?.[0]; const message = outer.get(2)?.[0];
  if (!mac || !message) throw new Error("invalid OMEMOAuthenticatedMessage");
  const inner = readFields(message); const ciphertext = inner.get(4)?.[0];
  if (!ciphertext) throw new Error("OMEMOMessage has no ciphertext");
  return { ciphertext, mac };
}

function material(key: Uint8Array): { enc: Buffer; auth: Buffer; iv: Buffer } {
  if (key.length !== 32) throw new Error(`OMEMO 2 payload key must be 32 bytes (got ${key.length})`);
  const out = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(key), ZERO_SALT, INFO, 80));
  return { enc: out.subarray(0, 32), auth: out.subarray(32, 64), iv: out.subarray(64, 80) };
}

export function encryptV2Payload(plaintext: Uint8Array): V2Payload {
  const key = new Uint8Array(crypto.randomBytes(32));
  const m = material(key);
  const cipher = crypto.createCipheriv("aes-256-cbc", m.enc, m.iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const mac = crypto.createHmac("sha256", m.auth).update(ciphertext).digest().subarray(0, 16);
  return { key, payload: encodeAuthenticatedMessage(ciphertext, mac) };
}

export function decryptV2Payload(payload: Uint8Array, key: Uint8Array): Uint8Array {
  const { ciphertext, mac } = decodeAuthenticatedMessage(payload);
  const m = material(key);
  const expected = crypto.createHmac("sha256", m.auth).update(ciphertext).digest().subarray(0, 16);
  if (!crypto.timingSafeEqual(Buffer.from(mac), expected)) throw new Error("OMEMO 2 payload HMAC verification failed");
  const decipher = crypto.createDecipheriv("aes-256-cbc", m.enc, m.iv);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
}
