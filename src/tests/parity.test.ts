// Test de regresión de paridad XMPP ↔ Telegram.
//
// No verifica comportamiento del plugin en runtime -- verifica que la
// clasificación del registro de comandos siga siendo exhaustiva. Si un
// upgrade de openclaw agrega un comando nuevo, este test se pone rojo en vez
// de que la brecha crezca en silencio (que es exactamente lo que pasó con
// EXPOSED_NATIVE_COMMAND_KEYS: quedó en 5/47 sin que nada lo señalara).
import { describe, expect, it } from "vitest";

import {
  buildParityReport,
  classifyCommands,
  findStaleDenyEntries,
  findUnclassified,
} from "../parity/analyze.js";
import { isAvailableToXmpp, loadRegistryCommands } from "../parity/registry.js";

describe("parity: registro de comandos nativos", () => {
  it("extrae comandos del registro real del dist instalado", () => {
    const commands = loadRegistryCommands();
    expect(commands.length).toBeGreaterThan(0);
    // Guarda contra una regresión de extracción silenciosa: si el bundler de
    // openclaw cambia de formato, esperamos que loadRegistryCommands() ya
    // lance (ver registry.ts), pero este assert es la doble verificación de
    // que seguimos viendo un número plausible, no un puñado de falsos
    // positivos de algún patrón demasiado laxo.
    expect(commands.length).toBeGreaterThanOrEqual(20);
  });

  it("todo comando restringido a otro provider tiene esa restricción explícita", () => {
    const commands = loadRegistryCommands();
    const restricted = commands.filter((c) => !isAvailableToXmpp(c));
    for (const command of restricted) {
      expect(command.providers?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("todo comando del registro está clasificado: expuesto, denegado con motivo, o no aplica a XMPP", () => {
    const classified = classifyCommands(loadRegistryCommands());
    const unclassified = findUnclassified(classified);

    if (unclassified.length > 0) {
      const names = unclassified.map((c) => c.name).join(", ");
      throw new Error(
        `${unclassified.length} comando(s) del registro sin clasificar: ${names}. ` +
          `Agregalos a EXPOSED_NATIVE_COMMAND_KEYS (native-commands.ts) si el plugin ` +
          `los va a exponer, o a DENY_REASONS (src/parity/deny-list.ts) con un motivo ` +
          `escrito si no. Un motivo provisional ("pendiente de revisar") es válido -- ` +
          `el punto es que la omisión quede visible, no que esté justificada a fondo.`,
      );
    }
    expect(unclassified).toHaveLength(0);
  });

  it("cada entrada denegada corresponde a un comando vivo del registro", () => {
    const classified = classifyCommands(loadRegistryCommands());
    const stale = findStaleDenyEntries(classified);

    if (stale.length > 0) {
      throw new Error(
        `${stale.length} entrada(s) de DENY_REASONS ya no corresponden a ningún ` +
          `comando denegado (el comando se eliminó del registro upstream, o se movió ` +
          `a EXPOSED_NATIVE_COMMAND_KEYS y quedó la entrada vieja sin borrar): ` +
          stale.join(", "),
      );
    }
    expect(stale).toHaveLength(0);
  });

  it("el reporte completo reconcilia: expuestos + denegados + no-aplican = total", () => {
    const report = buildParityReport();
    const { exposed, denied, "not-applicable": notApplicable, unclassified } = report.counts;
    expect(exposed + denied + notApplicable + unclassified).toBe(report.commands.length);
  });

  it("detecta deriva: un comando inventado, sin clasificar, hace fallar la clasificación", () => {
    // No tocamos el registro real -- construimos una lista sintética con un
    // comando fantasma para probar que el mecanismo de detección funciona,
    // sin depender de que el registro real tenga (o deje de tener) huecos.
    const withPhantom = [
      ...loadRegistryCommands(),
      { name: "__parity_test_phantom_command__" },
    ];
    const unclassified = findUnclassified(classifyCommands(withPhantom));
    expect(unclassified.map((c) => c.name)).toContain("__parity_test_phantom_command__");
  });
});

describe("parity: propiedades de config", () => {
  it("el manifiesto XMPP existe y es legible, aunque declare menos propiedades que Telegram", () => {
    const report = buildParityReport();
    // No es una aserción de "deben ser iguales" -- XMPP usa
    // additionalProperties:true a propósito (ver analyze.ts). Solo verificamos
    // que la lectura no rompe y que el número de Telegram es el esperado en
    // orden de magnitud, para detectar si el propio manifiesto de Telegram
    // cambia de forma drástica.
    expect(report.config.xmppCount).toBeGreaterThanOrEqual(1);
    expect(report.config.telegramCount).toBeGreaterThan(20);
  });
});
