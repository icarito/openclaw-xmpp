// Tarea 3.3 de xmpp-approval-bypass-and-fallback-cleanup: cubre los
// escenarios de specs/xmpp-approval-fallback-text/spec.md. No cubre "misma
// ruta nativa vs. forwarder" (eso es integración, ejercitado por
// approval-handler.runtime.ts y channel.ts compartiendo approval-text.ts) --
// solo la función de compactación en sí.
import { describe, expect, it } from "vitest";

import { compactApprovalFallbackText, stripEmptyFencedCodeBlocks } from "../send.js";

describe("stripEmptyFencedCodeBlocks", () => {
  it("elimina un bloque de fence sin contenido", () => {
    const input = "Pending command:\n```sh\n\n```\nExtra line";
    const result = stripEmptyFencedCodeBlocks(input);
    expect(result).not.toContain("```");
  });

  it("elimina un bloque de fence con solo whitespace", () => {
    const input = "```sh\n   \t  \n```\n";
    const result = stripEmptyFencedCodeBlocks(input);
    expect(result).not.toContain("```");
  });

  it("preserva un bloque de fence con contenido real", () => {
    const input = "```sh\nrm -rf /tmp/foo\n```\n";
    const result = stripEmptyFencedCodeBlocks(input);
    expect(result).toContain("rm -rf /tmp/foo");
    expect(result).toContain("```");
  });
});

describe("compactApprovalFallbackText", () => {
  it("omite por completo un bloque de fence vacío en vez de mostrar triples backticks vacíos", () => {
    const fallback = ["Pending command:", "```sh", "", "```", "Full id: abc123"].join("\n");
    const result = compactApprovalFallbackText(fallback);

    expect(result).not.toMatch(/```\s*```/);
    expect(result).not.toContain("Full id:");
  });

  it("preserva un bloque de fence con contenido de comando real", () => {
    const fallback = ["Pending command:", "```sh", "curl https://example.org", "```"].join("\n");
    const result = compactApprovalFallbackText(fallback);

    expect(result).toContain("curl https://example.org");
  });

  it("elimina las líneas de opciones de /approve y el bloque 'Other options'", () => {
    const fallback = [
      "Pending command:",
      "```sh",
      "ls -la",
      "```",
      "Other options:",
      "/approve abc123 allow-once",
      "/approve abc123 deny",
    ].join("\n");
    const result = compactApprovalFallbackText(fallback);

    expect(result).not.toContain("/approve ");
    expect(result).not.toContain("Other options:");
    expect(result).toContain("ls -la");
  });

  it("colapsa líneas en blanco múltiples y recorta bordes", () => {
    const fallback = "Line one\n\n\n\nLine two\n\n";
    const result = compactApprovalFallbackText(fallback);

    expect(result).toBe("Line one\n\nLine two");
  });
});
