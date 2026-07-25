// Extracción del registro de comandos nativos del core de OpenClaw.
//
// Por qué parseo textual y no `import`: `commands-registry.data-*.js` es ESM
// con imports a otros chunks del bundle (./string-coerce-*.js, ./thinking-*.js,
// etc.). Importarlo arrastraría medio runtime de openclaw y sus efectos de
// carga. El parseo es frágil ante un cambio de bundler, pero esa fragilidad es
// DETECTABLE: si devuelve 0 comandos fallamos ruidosamente, mientras que un
// import roto falla de formas mucho menos legibles.
//
// Por qué resolución por patrón y no por nombre literal: los archivos del dist
// llevan hash de contenido (commands-registry.data-BocP0_lr.js) que cambia
// entre releases. Buscar por nombre literal produciría exactamente el modo de
// falla que este módulo intenta eliminar -- romperse en silencio tras un
// upgrade, como le pasó al parche `single-pending-approval`, que reportó "todo
// al día" durante un día entero mientras su anchor ya no matcheaba nada.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type CommandTier = "essential" | "standard" | "power";

export type RegistryCommand = {
  /** `nativeName` del registro: el nombre con el que se invoca (`/context`). */
  name: string;
  /** Agrupación para el menú (`status`, `tools`, `session`, ...). Ausente en algunos. */
  category?: string;
  /** Nivel de exposición sugerido. Insumo del filtrado de la Fase 3. */
  tier?: CommandTier;
  /**
   * Providers a los que el registro restringe el comando. `undefined` = sin
   * restricción, o sea exponible por cualquier canal, XMPP incluido.
   */
  providers?: string[];
};

/** Falla de resolución o de extracción; nunca se confunde con "registro vacío". */
export class ParityExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParityExtractionError";
  }
}

/**
 * Localiza `openclaw/dist` desde este paquete, sin asumir el layout de
 * node_modules (npm puede hoistear, y un workspace lo movería).
 *
 * Se resuelve vía un subpath realmente exportado en vez de
 * `openclaw/package.json`, que NO está en el mapa de `exports` del paquete y
 * por lo tanto no es resoluble. `plugin-sdk/core` es el mismo subpath que ya
 * consume el runtime del plugin, así que si esto no resuelve, el plugin
 * tampoco arrancaría.
 */
export function resolveOpenclawDistDir(): string {
  const require = createRequire(import.meta.url);
  try {
    // .../openclaw/dist/plugin-sdk/core.js -> .../openclaw/dist
    return dirname(dirname(require.resolve("openclaw/plugin-sdk/core")));
  } catch (err) {
    throw new ParityExtractionError(
      `No se pudo resolver el paquete 'openclaw' desde este checkout. ` +
        `¿Corriste 'npm install'? Causa: ${(err as Error).message}`,
    );
  }
}

/**
 * Resuelve un artefacto del dist por patrón, exigiendo exactamente un match.
 *
 * El error nombra el patrón y la cantidad de candidatos para que un upgrade que
 * renombre o elimine el archivo produzca un mensaje accionable, en vez de un
 * reporte vacío que parezca válido.
 */
export function resolveDistArtifact(distDir: string, pattern: RegExp): string {
  let entries: string[];
  try {
    entries = readdirSync(distDir);
  } catch (err) {
    throw new ParityExtractionError(
      `No se pudo leer el dist de openclaw en ${distDir}: ${(err as Error).message}`,
    );
  }

  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new ParityExtractionError(
      `Se esperaba exactamente 1 archivo que matcheara ${pattern} en ${distDir}, ` +
        `se encontraron ${matches.length}${matches.length ? `: ${matches.join(", ")}` : ""}. ` +
        `Probablemente un upgrade de openclaw cambió el layout del dist; ` +
        `actualizá el patrón en src/parity/registry.ts.`,
    );
  }
  return join(distDir, matches[0]!);
}

// Un bloque `defineChatCommand({...})` por comando. Se corta en el `key:` del
// siguiente para no cruzar campos entre comandos vecinos.
const COMMAND_BLOCK_RE = /defineChatCommand\(\{([\s\S]*?)\n\t*\}\)/g;

// Tolera espacio tras los dos puntos y ambos tipos de comilla. Exigir la
// comilla es lo que distingue un literal de datos (`nativeName: "help"`) de la
// referencia a propiedad dentro de la propia función constructora
// (`nativeName: command.nativeName`), que no debe contarse.
const field = (name: string) => new RegExp(`\\b${name}:\\s*["']([^"']+)["']`);
const NATIVE_NAME_RE = field("nativeName");
const CATEGORY_RE = field("category");
const TIER_RE = field("tier");
const PROVIDERS_RE = /\bnativeProviders:\s*\[([^\]]*)\]/;

/** Extrae los comandos del texto del artefacto del registro. */
export function parseRegistryCommands(source: string): RegistryCommand[] {
  const commands: RegistryCommand[] = [];

  for (const [, body] of source.matchAll(COMMAND_BLOCK_RE)) {
    const name = body.match(NATIVE_NAME_RE)?.[1];
    // Sin nativeName es un comando solo-texto (scope "text"): no aparece en
    // ningún menú nativo, así que no es parte de la superficie de paridad.
    if (!name) continue;

    const providersRaw = body.match(PROVIDERS_RE)?.[1];
    const providers = providersRaw
      ?.split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    commands.push({
      name,
      category: body.match(CATEGORY_RE)?.[1],
      tier: body.match(TIER_RE)?.[1] as CommandTier | undefined,
      ...(providers?.length ? { providers } : {}),
    });
  }

  return commands;
}

/**
 * Carga el registro completo de comandos nativos del core.
 *
 * Trata "cero comandos" como fallo de extracción, no como registro vacío: un
 * registro genuinamente vacío no existe, así que el cero solo puede venir de un
 * cambio de formato del bundle.
 */
export function loadRegistryCommands(distDir = resolveOpenclawDistDir()): RegistryCommand[] {
  const artifactPath = resolveDistArtifact(distDir, /^commands-registry\.data-.*\.js$/);
  const source = readFileSync(artifactPath, "utf8");
  const commands = parseRegistryCommands(source);

  if (commands.length === 0) {
    throw new ParityExtractionError(
      `Se extrajeron 0 comandos de ${artifactPath}. El registro del core nunca ` +
        `está vacío, así que esto es un fallo de extracción: probablemente un ` +
        `cambio de bundler alteró el formato de los campos. ` +
        `Revisá los patrones en src/parity/registry.ts.`,
    );
  }

  return commands;
}

/** `true` si el comando es exponible por el canal XMPP según el propio registro. */
export function isAvailableToXmpp(command: RegistryCommand): boolean {
  return !command.providers || command.providers.includes("xmpp");
}
