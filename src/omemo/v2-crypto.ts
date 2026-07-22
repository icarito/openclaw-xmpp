/** OMEMO 2 payload cryptography and protobuf wire helpers.
 *
 * XEP-0384 0.9.x deliberately does not use AES-GCM.  The payload key is a
 * random 32-byte value; HKDF-SHA-256 (zero salt, `OMEMO Payload` info) derives
 * AES-256-CBC, HMAC-SHA-256 and IV material.  The HMAC is truncated to 16
 * bytes.  This module contains the small protobuf messages needed on the
 * wire, avoiding a generated runtime dependency.
 */
import crypto from "node:crypto";
import { WhisperMessage, PreKeyWhisperMessage } from "@privacyresearch/libsignal-protocol-protobuf-ts";

const INFO = Buffer.from("OMEMO Payload", "utf8");
const ZERO_SALT = Buffer.alloc(32);

export type V2Payload = { key: Uint8Array; payload: Uint8Array };
export interface V2PayloadOptions {
  /** Double Ratchet header for the session carrying this payload. */
  header: RatchetHeader;
  /** AD = Encode(IK_A) || Encode(IK_B), in initiator/responder order. */
  associatedData: Uint8Array;
}

/**
 * Extract the Double Ratchet header carried by a libsignal wire message.
 * libsignal prefixes the protobuf with the version byte.  Pre-key messages
 * wrap a WhisperMessage inside PreKeyWhisperMessage, while regular messages
 * contain WhisperMessage directly.  This is intentionally kept separate
 * from decryption: the public SessionCipher API only returns the plaintext,
 * but OMEMO 2 needs n/pn/dh_pub in the authenticated payload.
 */
export function extractRatchetHeader(signalMessage: Uint8Array): RatchetHeader {
  if (signalMessage.length < 2) throw new Error("Signal message is empty");
  const version = signalMessage[0]!;
  if ((version & 0x0f) > 3 || (version >> 4) < 3) {
    throw new Error(`Unsupported Signal message version ${version}`);
  }

  let whisperBytes: Uint8Array | undefined;
  // Both message kinds use version 0x33 in this libsignal release. Decode a
  // pre-key wrapper opportunistically; regular WhisperMessage has no field 3
  // (`message`) and therefore leaves this unset.
  try {
    const preKey = PreKeyWhisperMessage.decode(signalMessage.slice(1));
    if (preKey.message?.length) whisperBytes = new Uint8Array(preKey.message);
  } catch {
    // Fall through to regular WhisperMessage below.
  }
  if (!whisperBytes) whisperBytes = signalMessage;
  if (whisperBytes.length < 10) throw new Error("Signal WhisperMessage is truncated");
  const body = whisperBytes.slice(1, whisperBytes.length - 8);
  const message = WhisperMessage.decode(body);
  return {
    n: message.counter >>> 0,
    pn: message.previousCounter >>> 0,
    dh_pub: new Uint8Array(message.ephemeralKey),
  };
}

/** Return the bare form of a JID (the form required by OMEMO/SCE). */
export function bareJid(jid: string): string {
  const value = jid.trim();
  const slash = value.indexOf("/");
  return slash < 0 ? value : value.slice(0, slash);
}

/**
 * Signal associated data for an OMEMO session.  XEP-0384 defines this as
 * Encode(IK_A) || Encode(IK_B), never as JID text or a protobuf envelope.
 */
export function associatedData(identityKeyA: Uint8Array, identityKeyB: Uint8Array): Uint8Array {
  const a = Buffer.from(identityKeyA);
  const b = Buffer.from(identityKeyB);
  return new Uint8Array(Buffer.concat([a, b]));
}

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
export interface RatchetHeader {
  n: number;
  pn: number;
  dh_pub: Uint8Array;
}

export function encodeAuthenticatedMessage(
  ciphertext: Uint8Array,
  mac: Uint8Array,
  header: RatchetHeader = { n: 0, pn: 0, dh_pub: new Uint8Array() },
): Uint8Array {
  const message = Buffer.concat([
    Buffer.concat([Buffer.from([0x08]), varint(header.n >>> 0)]),
    Buffer.concat([Buffer.from([0x10]), varint(header.pn >>> 0)]),
    bytesField(3, header.dh_pub),
    bytesField(4, ciphertext),
  ]);
  return Buffer.concat([bytesField(1, mac), bytesField(2, message)]);
}

function serializeMessage(ciphertext: Uint8Array, header: RatchetHeader): Buffer {
  if (!Number.isInteger(header.n) || header.n < 0 || !Number.isInteger(header.pn) || header.pn < 0) {
    throw new Error("OMEMO 2 ratchet counters must be non-negative integers");
  }
  if (header.dh_pub.length !== 32) {
    throw new Error(`OMEMO 2 ratchet dh_pub must be 32 bytes (got ${header.dh_pub.length})`);
  }
  return Buffer.concat([
    Buffer.from([0x08]), varint(header.n >>> 0),
    Buffer.from([0x10]), varint(header.pn >>> 0),
    bytesField(3, header.dh_pub), bytesField(4, ciphertext),
  ]);
}

/** Build the authenticated protobuf using XEP-0384's AD || OMEMOMessage MAC input. */
export function encodeAuthenticatedMessageWithAd(
  ciphertext: Uint8Array,
  authKey: Uint8Array,
  header: RatchetHeader,
  associatedData: Uint8Array,
): Uint8Array {
  const message = serializeMessage(ciphertext, header);
  const mac = crypto.createHmac("sha256", Buffer.from(authKey))
    .update(Buffer.concat([Buffer.from(associatedData), message])).digest().subarray(0, 16);
  return Buffer.concat([bytesField(1, mac), bytesField(2, message)]);
}

/** Rebuild the authenticated protobuf with the Signal Double Ratchet header. */
export function withRatchetHeader(payload: Uint8Array, header: RatchetHeader): Uint8Array {
  const decoded = decodeAuthenticatedMessage(payload);
  return encodeAuthenticatedMessage(decoded.ciphertext, decoded.mac, header);
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

export function encryptV2Payload(plaintext: Uint8Array, options: V2PayloadOptions): V2Payload {
  if (!options?.header || !options?.associatedData) {
    throw new Error("OMEMO 2 requires a ratchet header and associated data");
  }
  const key = new Uint8Array(crypto.randomBytes(32));
  const m = material(key);
  const cipher = crypto.createCipheriv("aes-256-cbc", m.enc, m.iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  // The key transported through each Signal session is key || HMAC(ciphertext).
  // The protobuf carries a separate MAC over AD || OMEMOMessage.
  const payloadMac = crypto.createHmac("sha256", m.auth).update(ciphertext).digest().subarray(0, 16);
  const payload = encodeAuthenticatedMessageWithAd(ciphertext, m.auth, options.header, options.associatedData);
  return { key: new Uint8Array(Buffer.concat([Buffer.from(key), payloadMac])), payload };
}

export function decryptV2Payload(payload: Uint8Array, key: Uint8Array, options: V2PayloadOptions): Uint8Array {
  const { ciphertext, mac } = decodeAuthenticatedMessage(payload);
  if (key.length !== 32 && key.length !== 48) throw new Error("OMEMO 2 transport key must be 32 or 48 bytes");
  const m = material(key.subarray(0, 32));
  const message = serializeMessage(ciphertext, options.header);
  const expected = crypto.createHmac("sha256", m.auth)
    .update(Buffer.concat([Buffer.from(options.associatedData), message])).digest().subarray(0, 16);
  if (!crypto.timingSafeEqual(Buffer.from(mac), expected)) throw new Error("OMEMO 2 authenticated message MAC verification failed");
  if (key.length >= 48 && !crypto.timingSafeEqual(Buffer.from(key.subarray(32, 48)), Buffer.from(mac))) {
    throw new Error("OMEMO 2 transport MAC mismatch");
  }
  const decipher = crypto.createDecipheriv("aes-256-cbc", m.enc, m.iv);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
}
