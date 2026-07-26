// Fase 2 (xmpp-approval-unified-contract), tarea 1: el <x type="result">
// adjunto al <command status="completed"> es aditivo al <note> existente.
// Verifica el shape exacto del stanza saliente, no solo que el código
// compile.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { describe, expect, it } from "vitest";

import { createActionDispatcher, type XmppAction } from "../actions.js";
import { Xep0050Handler } from "../xep-0050.js";

const COMMAND_NS = "http://jabber.org/protocol/commands";

function noParamsAction(node: string, handler: XmppAction["handler"]): XmppAction {
  return { node, name: node, description: node, params: [], mutating: false, handler };
}

function buildExecuteIq(node: string): Element {
  return xml(
    "iq",
    { type: "set", id: "iq1", from: "user@example.org/res" },
    xml("command", { xmlns: COMMAND_NS, node, action: "execute" }),
  );
}

describe("Xep0050Handler: result form", () => {
  it("un handler que retorna string plano no adjunta ningún <x>, solo <note>", async () => {
    const dispatcher = createActionDispatcher([noParamsAction("status", () => "todo bien")]);
    const handler = new Xep0050Handler({ dispatcher, accountId: "default" });

    const result = await handler.handleIq(buildExecuteIq("status"));

    const command = result?.getChild("command", COMMAND_NS);
    expect(command?.getChild("note")?.getText()).toBe("todo bien");
    expect(command?.getChild("x", "jabber:x:data")).toBeUndefined();
  });

  it("un handler que retorna {text, fields} adjunta <x type=result> junto al <note>", async () => {
    const dispatcher = createActionDispatcher([
      noParamsAction("elevated", () => ({
        text: "Elevated: activo, quedan 8m.",
        fields: [
          { var: "active", value: "true" },
          { var: "remaining-seconds", value: "480" },
        ],
      })),
    ]);
    const handler = new Xep0050Handler({ dispatcher, accountId: "default" });

    const result = await handler.handleIq(buildExecuteIq("elevated"));

    const command = result?.getChild("command", COMMAND_NS);
    // El <note> humano-legible se preserva sin cambios.
    expect(command?.getChild("note")?.getText()).toBe("Elevated: activo, quedan 8m.");

    // El <x type="result"> es aditivo, con un <field var><value> por entrada.
    const resultForm = command?.getChild("x", "jabber:x:data");
    expect(resultForm?.attrs.type).toBe("result");
    const fields = resultForm?.getChildren("field") ?? [];
    expect(fields.map((f) => f.attrs.var)).toEqual(["active", "remaining-seconds"]);
    expect(fields[0]?.getChild("value")?.getText()).toBe("true");
    expect(fields[1]?.getChild("value")?.getText()).toBe("480");
  });

  it("un handler que retorna {text} sin fields no adjunta <x> (fields vacío/ausente)", async () => {
    const dispatcher = createActionDispatcher([
      noParamsAction("noop", () => ({ text: "sin campos" })),
    ]);
    const handler = new Xep0050Handler({ dispatcher, accountId: "default" });

    const result = await handler.handleIq(buildExecuteIq("noop"));

    const command = result?.getChild("command", COMMAND_NS);
    expect(command?.getChild("note")?.getText()).toBe("sin campos");
    expect(command?.getChild("x", "jabber:x:data")).toBeUndefined();
  });
});
