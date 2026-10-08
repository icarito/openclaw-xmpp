import { describe, it, expect, beforeEach } from "vitest";
import {
  noteInboundEncryption,
  shouldEncryptDirect,
  resetInboundEncryption,
} from "../omemo/inbound-mirror.js";

describe("OMEMO inbound mirroring", () => {
  beforeEach(() => resetInboundEncryption());

  it("encrypts for unknown peers (proactive messages keep old behavior)", () => {
    expect(shouldEncryptDirect("a", "u@h", {})).toBe(true);
  });

  it("replies in plaintext when the peer's last message was plaintext", () => {
    noteInboundEncryption("a", "u@h", false);
    expect(shouldEncryptDirect("a", "U@H", {})).toBe(false);
  });

  it("encrypts again once the peer writes encrypted", () => {
    noteInboundEncryption("a", "u@h", false);
    noteInboundEncryption("a", "u@h", true);
    expect(shouldEncryptDirect("a", "u@h", {})).toBe(true);
  });

  it("requireEncryption and mirrorInbound=false always encrypt", () => {
    noteInboundEncryption("a", "u@h", false);
    expect(shouldEncryptDirect("a", "u@h", { requireEncryption: true })).toBe(true);
    expect(shouldEncryptDirect("a", "u@h", { mirrorInbound: false })).toBe(true);
  });

  it("is scoped per account", () => {
    noteInboundEncryption("a", "u@h", false);
    expect(shouldEncryptDirect("b", "u@h", {})).toBe(true);
  });
});
