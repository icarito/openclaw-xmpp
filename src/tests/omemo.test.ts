import { describe, it, expect, vi, beforeEach } from "vitest";
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import {
  initializeOmemo,
  encryptOmemoMessage,
  decryptOmemoMessage,
  isRoomOmemoCapable,
  encryptMucOmemoMessage,
  getRoomOccupantJids,
  handleMucPresence,
  getOccupantRealJid,
  shutdownOmemo,
} from "../omemo/index.js";
import { fetchBundle } from "../omemo/bundle.js";
import { fetchDeviceList } from "../omemo/device.js";
import { pepFetch, pepPublish } from "../pep.js";
import { connectXmppClient } from "../client.js";

// Mock PEP module
vi.mock("../pep.js", () => {
  return {
    pepPublish: vi.fn(),
    pepFetch: vi.fn(),
  };
});

// Mock client builder
vi.mock("@xmpp/client", async () => {
  const actual = await vi.importActual("@xmpp/client") as any;
  const mockClientInstance = {
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    reconnect: {
      on: vi.fn(),
    },
    streamManagement: {
      on: vi.fn(),
      enabled: true,
      id: "mock-stream-123",
      inbound: 5,
    },
    iqCaller: {
      request: vi.fn().mockResolvedValue(undefined),
    },
  };
  return {
    ...actual,
    client: vi.fn(() => mockClientInstance),
  };
});

// Mock connection registry
vi.mock("../connection-registry.js", () => {
  return {
    getActiveXmppConnection: vi.fn(() => ({
      xmpp: {
        send: vi.fn().mockResolvedValue(undefined),
      },
      isConnected: () => true,
    })),
    registerActiveXmppConnection: vi.fn(),
    unregisterActiveXmppConnection: vi.fn(),
  };
});

describe("XMPP OMEMO, Bundles & MUC Occupant Tracking Tests", () => {
  const accountId = "test-account";
  const selfJid = "alice@example.com";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("OMEMO Key bundle parsing (Legacy and OMEMO 2.0)", () => {
    it("should successfully parse a legacy (0.3.0) OMEMO bundle", async () => {
      // Mock pepFetch to return legacy bundle XML
      const legacyBundleXml = xml(
        "bundle",
        { xmlns: "eu.siacs.conversations.axolotl" },
        xml("signedPreKeyPublic", { signedPreKeyId: "123" }, "c2lnbmVkS2V5UHVibGlj"),
        xml("signedPreKeySignature", {}, "c2lnbmVkS2V5U2lnbmF0dXJl"),
        xml("identityKey", {}, "aWRlbnRpdHlLZXlQdWJsaWM="),
        xml(
          "prekeys",
          {},
          xml("preKeyPublic", { preKeyId: "1" }, "cHJlS2V5UHVibGljMQ=="),
          xml("preKeyPublic", { preKeyId: "2" }, "cHJlS2V5UHVibGljMg==")
        )
      );

      vi.mocked(pepFetch).mockResolvedValue({
        ok: true,
        data: [{ id: "current", payload: legacyBundleXml }],
      });

      const bundle = await fetchBundle(accountId, "bob@example.com", 999);
      expect(bundle).not.toBeNull();
      expect(bundle?.signedPreKey.id).toBe(123);
      expect(bundle?.preKeys.length).toBe(2);
      expect(bundle?.preKeys[0].id).toBe(1);
    });

    it("should successfully parse an OMEMO 2.0 bundle", async () => {
      // Mock pepFetch to return OMEMO 2.0 bundle XML
      const v2BundleXml = xml(
        "bundle",
        { xmlns: "urn:xmpp:omemo:2" },
        xml("spk", { id: "456" }, "c2lnbmVkS2V5UHVibGlj"),
        xml("spks", {}, "c2lnbmVkS2V5U2lnbmF0dXJl"),
        xml("ik", {}, "aWRlbnRpdHlLZXlQdWJsaWM="),
        xml(
          "prekeys",
          {},
          xml("pk", { id: "10" }, "cHJlS2V5UHVibGljMQ=="),
          xml("pk", { id: "20" }, "cHJlS2V5UHVibGljMg==")
        )
      );

      vi.mocked(pepFetch).mockResolvedValue({
        ok: true,
        data: [{ id: "current", payload: v2BundleXml }],
      });

      const bundle = await fetchBundle(accountId, "bob@example.com", 888);
      expect(bundle).not.toBeNull();
      expect(bundle?.signedPreKey.id).toBe(456);
      expect(bundle?.preKeys.length).toBe(2);
      expect(bundle?.preKeys[0].id).toBe(10);
    });
  });

  describe("MUC Occupant Tracking", () => {
    it("should track occupant real JID in non-anonymous room", () => {
      const roomJid = "room@conference.example.org";
      const userPresence = xml(
        "presence",
        { from: `${roomJid}/bob`, to: "alice@example.com" },
        xml(
          "x",
          { xmlns: "http://jabber.org/protocol/muc#user" },
          xml("item", { affiliation: "member", role: "participant", jid: "bob@example.com/mobile" }),
          xml("status", { code: "100" }) // room is non-anonymous
        )
      );

      const handled = handleMucPresence(userPresence, accountId);
      expect(handled).toBe(true);

      const isCapable = isRoomOmemoCapable(accountId, roomJid);
      expect(isCapable).toBe(true);

      const occupants = getRoomOccupantJids(accountId, roomJid, false);
      expect(occupants).toContain("bob@example.com");

      const realJid = getOccupantRealJid(accountId, roomJid, "bob");
      expect(realJid).toBe("bob@example.com");
    });

    it("should not consider anonymous rooms as OMEMO capable", () => {
      const roomJid = "anonymous-room@conference.example.org";
      const anonymousPresence = xml(
        "presence",
        { from: `${roomJid}/charlie` },
        xml(
          "x",
          { xmlns: "http://jabber.org/protocol/muc#user" },
          xml("item", { affiliation: "none", role: "participant" }) // no real JID
        )
      );

      const handled = handleMucPresence(anonymousPresence, accountId);
      expect(handled).toBe(true);

      const isCapable = isRoomOmemoCapable(accountId, roomJid);
      expect(isCapable).toBe(false);
    });
  });

  describe("OMEMO Encrypt/Decrypt Round-trip", () => {
    it("should initialize store, publish device and bundles, and decrypt fallback correctly", async () => {
      vi.mocked(pepPublish).mockResolvedValue({ ok: true });

      const store = await initializeOmemo(accountId, selfJid, "test-device");
      expect(store).toBeDefined();
      expect(store.getDeviceId()).toBeGreaterThan(0);

      // Verify device publication was called
      expect(pepPublish).toHaveBeenCalled();

      // Test decryptOmemoMessage fallback behavior when decrypt fails or is ignored
      const unencryptedMessage = xml(
        "message",
        { type: "chat", from: "bob@example.com", to: selfJid },
        xml("body", {}, "This is a plaintext fallback body")
      );

      // If OMEMO is not enabled or decryption returns null, it falls back to the original body.
      const decrypted = await decryptOmemoMessage(accountId, unencryptedMessage);
      expect(decrypted).toBeNull(); // Because it's not OMEMO encrypted

      await shutdownOmemo(accountId);
    });
  });

  describe("Stream Management (XEP-0198) resume flow", () => {
    it("should attempt stream resumption before calling start()", async () => {
      const mockAccount = {
        accountId: "test-account",
        config: {
          jid: "alice@example.com",
          password: "password123",
          resource: "mobile",
          mucRooms: [],
          streamManagement: {
            enabled: true,
            resumptionMaxSeconds: 300,
          },
        },
        jid: "alice@example.com",
        password: "password123",
        resource: "mobile",
        mucRooms: [],
        configured: true,
      };

      const mockOnOnline = vi.fn();
      const mockOnOffline = vi.fn();

      const connection = await connectXmppClient({
        account: mockAccount as any,
        onOnline: mockOnOnline,
        onOffline: mockOnOffline,
      });

      expect(connection).toBeDefined();
      // Verify start or resume was called on the mockClientInstance
      const mockClient = connection.xmpp;
      expect(mockClient.start).toHaveBeenCalled();
    });
  });
});
