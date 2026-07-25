import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Omemo2SidecarClient, type Omemo2Callback } from "../omemo/sidecar-client.js";

type PepState = {
  devices: Map<string, string>;
  bundles: Map<string, string>;
  transports: Array<{ from: string; to: string; payload: string }>;
};

const pep: PepState = { devices: new Map(), bundles: new Map(), transports: [] };
const python = process.env.OPENCLAW_OMEMO2_PYTHON
  ?? "/home/icarito/Proyectos/gtk-llm-chat/.venv/bin/python";
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../omemo/sidecar.py");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-omemo2-e2e-"));

function handler(owner: string) {
  return async (method: Omemo2Callback, params: Record<string, unknown>): Promise<unknown> => {
    const jid = String(params.jid ?? owner);
    const deviceId = Number(params.deviceId);
    switch (method) {
      case "upload_device_list": pep.devices.set(owner, String(params.payload)); return { ok: true };
      case "download_device_list": return pep.devices.get(jid)
        ?? '<devices xmlns="urn:xmpp:omemo:2"/>';
      case "upload_bundle": pep.bundles.set(`${owner}:${deviceId}`, String(params.payload)); return { ok: true };
      case "download_bundle": {
        const bundle = pep.bundles.get(`${jid}:${deviceId}`);
        if (!bundle) throw new Error(`missing bundle ${jid}:${deviceId}`);
        return bundle;
      }
      case "delete_bundle": pep.bundles.delete(`${owner}:${deviceId}`); return { ok: true };
      case "send_message":
        pep.transports.push({ from: owner, to: jid, payload: String(params.payload) });
        return { ok: true };
    }
  };
}

let alice = new Omemo2SidecarClient(python, script, handler("alice@example.test"));
const bob = new Omemo2SidecarClient(python, script, handler("bob@example.test"));

try {
  const a = await alice.request<{ deviceId: number }>("initialize", {
    accountId: "alice", jid: "alice@example.test", label: "Alice", stateDir,
  });
  const b = await bob.request<{ deviceId: number }>("initialize", {
    accountId: "bob", jid: "bob@example.test", label: "Bob", stateDir,
  });
  const aliceBundle = pep.bundles.get(`alice@example.test:${a.deviceId}`)!;
  const bobBundle = pep.bundles.get(`bob@example.test:${b.deviceId}`)!;
  if (!aliceBundle.includes("<ns0:ik>") || !bobBundle.includes("<ns0:ik>")) {
    throw new Error("missing OMEMO 2 identity key");
  }
  const first = await alice.request<{ messages: string[]; errors: string[] }>("encrypt", {
    jids: ["bob@example.test"], plaintext: "first genuine OMEMO 2 message",
  });
  if (first.messages.length !== 1) throw new Error(`first encrypt failed: ${first.errors.join("; ")}`);
  const opened = await bob.request<{ plaintext: string }>("decrypt", {
    jid: "alice@example.test", payload: first.messages[0],
  });
  if (Buffer.from(opened.plaintext, "base64").toString() !== "first genuine OMEMO 2 message") {
    throw new Error("first plaintext mismatch");
  }
  await alice.stop();
  alice = new Omemo2SidecarClient(python, script, handler("alice@example.test"));
  await alice.request("initialize", {
    accountId: "alice", jid: "alice@example.test", label: "Alice", stateDir,
  });
  const second = await alice.request<{ messages: string[]; errors: string[] }>("encrypt", {
    jids: ["bob@example.test"], plaintext: "double ratchet follow-up",
  });
  const openedSecond = await bob.request<{ plaintext: string }>("decrypt", {
    jid: "alice@example.test", payload: second.messages[0],
  });
  if (Buffer.from(openedSecond.plaintext, "base64").toString() !== "double ratchet follow-up") {
    throw new Error("ratchet plaintext mismatch");
  }
  process.stdout.write(JSON.stringify({ ok: true, aliceDevice: a.deviceId, bobDevice: b.deviceId }) + "\n");
} finally {
  await alice.stop();
  await bob.stop();
}
