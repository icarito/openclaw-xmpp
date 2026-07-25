// Análisis de paridad: junta el registro del core, el lado XMPP y el
// manifiesto de Telegram, y clasifica cada comando en exactamente una
// categoría. Sin efectos de I/O más allá de leer archivos versionados.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXPOSED_NATIVE_COMMAND_KEYS } from "../native-commands.js";
import { DENY_REASONS } from "./deny-list.js";
import {
  type RegistryCommand,
  ParityExtractionError,
  isAvailableToXmpp,
  loadRegistryCommands,
  resolveOpenclawDistDir,
} from "./registry.js";

/**
 * Clasificación de un comando del registro. Es exhaustiva y excluyente: el
 * test de paridad falla si algún comando queda fuera de las tres primeras.
 */
export type CommandStatus =
  /** Expuesto por el plugin vía XEP-0050. */
  | "exposed"
  /** No expuesto, con motivo escrito en la deny-list. */
  | "denied"
  /** El registro lo restringe a otros providers; no aplica a XMPP. */
  | "not-applicable"
  /** Ni expuesto, ni denegado, ni restringido: falta clasificar. */
  | "unclassified";

export type ClassifiedCommand = RegistryCommand & {
  status: CommandStatus;
  /** Presente solo cuando `status === "denied"`. */
  reason?: string;
};

export function classifyCommands(commands: RegistryCommand[]): ClassifiedCommand[] {
  const exposed = new Set(EXPOSED_NATIVE_COMMAND_KEYS);

  return commands.map((command) => {
    if (!isAvailableToXmpp(command)) return { ...command, status: "not-applicable" as const };
    if (exposed.has(command.name)) return { ...command, status: "exposed" as const };

    const reason = DENY_REASONS[command.name];
    if (reason) return { ...command, status: "denied" as const, reason };

    return { ...command, status: "unclassified" as const };
  });
}

/** Comandos sin clasificar: lo que hace fallar al test tras un upgrade. */
export function findUnclassified(classified: ClassifiedCommand[]): ClassifiedCommand[] {
  return classified.filter((command) => command.status === "unclassified");
}

/**
 * Entradas de la deny-list que ya no corresponden a ningún comando del
 * registro (porque el comando se eliminó upstream, o porque se expuso y quedó
 * la entrada vieja). Mantenerlas engaña: parecen decisiones vigentes.
 */
export function findStaleDenyEntries(classified: ClassifiedCommand[]): string[] {
  const live = new Set(
    classified.filter((c) => c.status === "denied").map((c) => c.name),
  );
  return Object.keys(DENY_REASONS)
    .filter((name) => !live.has(name))
    .sort();
}

// --- Config schema ----------------------------------------------------------

export type ConfigPropertyDiff = {
  telegramCount: number;
  xmppCount: number;
  /** Propiedades declaradas por Telegram y ausentes del manifiesto XMPP. */
  missingInXmpp: string[];
};

function readChannelManifestProperties(manifestPath: string, channelId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new ParityExtractionError(
      `No se pudo leer el manifiesto ${manifestPath}: ${(err as Error).message}`,
    );
  }

  const schema = (parsed as Record<string, any>)?.channelConfigs?.[channelId]?.schema;
  return Object.keys(schema?.properties ?? {}).sort();
}

/**
 * Diff de propiedades de config declaradas en los manifiestos.
 *
 * OJO al interpretar el resultado: que Telegram declare ~56 propiedades y XMPP
 * 1 NO es una brecha funcional. El schema Zod de XMPP (src/config-schema.ts) es
 * rico, y como el manifiesto declara `additionalProperties: true`, la config
 * valida igual. Lo que degrada es la UI de setup y `openclaw doctor`, que leen
 * el manifiesto. La solución no es escribir 56 propiedades a mano, sino generar
 * el manifiesto desde el schema Zod.
 */
export function diffConfigProperties(distDir = resolveOpenclawDistDir()): ConfigPropertyDiff {
  const telegram = readChannelManifestProperties(
    join(distDir, "extensions", "telegram", "openclaw.plugin.json"),
    "telegram",
  );
  const xmpp = readChannelManifestProperties(
    new URL("../../openclaw.plugin.json", import.meta.url).pathname,
    "xmpp",
  );

  const xmppSet = new Set(xmpp);
  return {
    telegramCount: telegram.length,
    xmppCount: xmpp.length,
    missingInXmpp: telegram.filter((name) => !xmppSet.has(name)),
  };
}

// --- Reporte completo -------------------------------------------------------

export type ParityReport = {
  commands: ClassifiedCommand[];
  counts: Record<CommandStatus, number>;
  unclassified: ClassifiedCommand[];
  staleDenyEntries: string[];
  config: ConfigPropertyDiff;
};

export function buildParityReport(distDir = resolveOpenclawDistDir()): ParityReport {
  const classified = classifyCommands(loadRegistryCommands(distDir));

  const counts: Record<CommandStatus, number> = {
    exposed: 0,
    denied: 0,
    "not-applicable": 0,
    unclassified: 0,
  };
  for (const command of classified) counts[command.status] += 1;

  return {
    commands: classified,
    counts,
    unclassified: findUnclassified(classified),
    staleDenyEntries: findStaleDenyEntries(classified),
    config: diffConfigProperties(distDir),
  };
}
