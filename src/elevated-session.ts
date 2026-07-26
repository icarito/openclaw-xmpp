// Host-side XMPP command for a TEMPORARY, session-scoped elevated bypass.
// Replaces the earlier, independently-invented approval-bypass.ts (which
// patched execSecurity/execAsk directly) and approval-mode.ts (agent-wide,
// persistent, required a gateway restart) -- see
// xmpp-elevated-session-command proposal.md for the consolidation
// rationale. This is now the ONLY session-scoped bypass mechanism exposed
// by this plugin.
//
// This command sets the invoking session's elevatedLevel (the core-native
// override mechanism backed by SessionEntry.elevatedLevel) to "full" via
// getSessionEntry/patchSessionEntry from
// openclaw/plugin-sdk/session-store-runtime, which the core re-reads every
// turn -- no restart, no config file write, and scoped to one session
// rather than the whole agent. The core resolves bypassApprovals from
// elevatedLevel:"full" provided exec-approvals.json's security/ask do not
// explicitly block it (a host-level prerequisite outside this plugin's
// control -- see OPERATIONS.md).
//
// The in-memory timer (`activeBypasses`) is the fast path when the gateway
// process does not restart. The bypass's expiration and pre-bypass
// elevatedLevel are ALSO persisted in the session store under
// pluginExtensions.xmpp.elevatedBypass -- this is what turns a restart
// during an active bypass into fail-closed instead of fail-open: the timer
// is lost on restart, but sweepExpiredElevatedBypasses() reads the
// persisted record on plugin load and reverts anything already expired.
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { ActionContext, ActionResult, XmppAction } from "./actions.js";
import { normalizeXmppAllowEntry } from "./normalize.js";
import type { CoreConfig } from "./types.js";

const DEFAULT_BYPASS_MINUTES = 10;
const MAX_BYPASS_MINUTES = 60;

// The only elevatedLevel this command ever writes. The core's ElevatedLevel
// union also has "on"/"ask", but exposing those here would recreate the
// multi-mechanism confusion this change removes -- on/off/status is a
// binary bypass, not a level picker (see design.md D2).
const BYPASS_ELEVATED_LEVEL = "full";

const PLUGIN_NAMESPACE = "xmpp";
const BYPASS_EXTENSION_KEY = "elevatedBypass";

type BypassEntry = {
  sessionKey: string;
  previousElevatedLevel: string | undefined;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
};

/** Shape persisted under `SessionEntry.pluginExtensions.xmpp.elevatedBypass`.
 *  Plain JSON (string | number | null, no undefined) -- SessionPluginJsonValue
 *  doesn't accept undefined, so the previous-level field uses null when
 *  there was no prior value to restore. */
type PersistedBypass = {
  expiresAtMs: number;
  previousElevatedLevel: string | null;
};

// In-memory only, by design -- see module header. Keyed by sessionKey, not
// by agent, so two different agents' sessions never collide even if a
// sessionKey were somehow reused (they aren't, but the key is the natural
// unit here: this is a per-session override).
const activeBypasses = new Map<string, BypassEntry>();

function isAuthorized(account: ResolvedXmppAccount, ctx?: ActionContext): boolean {
  const sender = normalizeXmppAllowEntry(ctx?.fromJid ?? "");
  if (!sender) return false;
  return (account.config.allowFrom ?? []).some((entry) => {
    const normalized = normalizeXmppAllowEntry(String(entry));
    return normalized === "*" || normalized === sender;
  });
}

function formatRemaining(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)}m`;
}

function resolveRoute(params: { account: ResolvedXmppAccount; cfg: CoreConfig; fromJid: string }) {
  return resolveAgentRoute({
    cfg: params.cfg as unknown as Parameters<typeof resolveAgentRoute>[0]["cfg"],
    channel: "xmpp",
    accountId: params.account.accountId,
    peer: { kind: "direct", id: params.fromJid },
  });
}

/** Removes the persisted bypass record from a session entry's
 *  pluginExtensions, preserving every other namespace/key untouched. */
function clearPersistedBypass(entry: Pick<SessionEntry, "pluginExtensions"> | undefined): SessionEntry["pluginExtensions"] {
  const xmppExt = { ...(entry?.pluginExtensions?.[PLUGIN_NAMESPACE] ?? {}) };
  delete xmppExt[BYPASS_EXTENSION_KEY];
  return {
    ...entry?.pluginExtensions,
    [PLUGIN_NAMESPACE]: xmppExt,
  };
}

/** Reverts one session's elevatedLevel to its pre-bypass value, clears the
 *  tracked in-memory entry (if any) and the persisted record. Shared by
 *  mode=off, the expiry timer, and the startup sweep -- so there is exactly
 *  one code path that performs a reversion, regardless of which of the
 *  three triggered it. */
async function revertBypass(params: {
  agentId: string;
  sessionKey: string;
  previousElevatedLevel: string | undefined;
  timer?: ReturnType<typeof setTimeout>;
}): Promise<void> {
  if (params.timer) clearTimeout(params.timer);
  activeBypasses.delete(params.sessionKey);
  await patchSessionEntry({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    update: (entry) => ({
      elevatedLevel: params.previousElevatedLevel,
      pluginExtensions: clearPersistedBypass(entry),
    }),
  });
}

/**
 * Sweeps every session for a persisted bypass whose expiration has already
 * passed, and reverts it. Meant to run once at plugin load
 * (`index.ts`'s `registerFull`), fire-and-forget.
 *
 * Unlike reconciling orphaned core approvals (blocked: plugin-sdk exposes no
 * endpoint to enumerate those), this IS implementable: the plugin owns this
 * record end to end, so there is no core state to reconcile against -- only
 * the plugin's own persisted state to read and act on locally.
 */
export async function sweepExpiredElevatedBypasses(): Promise<{ reverted: number }> {
  const nowMs = Date.now();
  const entries = listSessionEntries({});
  let reverted = 0;

  for (const { sessionKey, entry } of entries) {
    const persisted = entry.pluginExtensions?.[PLUGIN_NAMESPACE]?.[BYPASS_EXTENSION_KEY] as
      | PersistedBypass
      | undefined;
    if (!persisted || persisted.expiresAtMs >= nowMs) continue;

    const agentId = deriveAgentIdFromSessionKey(sessionKey);
    if (!agentId) continue;

    await revertBypass({
      agentId,
      sessionKey,
      previousElevatedLevel: persisted.previousElevatedLevel ?? undefined,
    });
    reverted += 1;
  }

  return { reverted };
}

/** `sessionKey` is shaped `agent:<agentId>:...` (buildAgentSessionKey);
 *  agentId is the first colon-delimited segment after the literal "agent". */
function deriveAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1];
}

export function buildElevatedSessionAction(params: {
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  node?: string;
  name?: string;
  description?: string;
}): XmppAction {
  const { account, cfg } = params;
  return {
    node: params.node ?? "elevated",
    name: params.name ?? "Elevated: temporary session bypass",
    description:
      params.description ??
      "Activa el nivel elevado nativo (elevatedLevel=full) SOLO para esta conversacion, "
        + `por N minutos (default ${DEFAULT_BYPASS_MINUTES}, maximo ${MAX_BYPASS_MINUTES}). `
        + "Se revierte solo al expirar, sin reiniciar el gateway. Unico mecanismo de bypass "
        + "de sesion expuesto por este plugin.",
    params: [
      {
        name: "mode",
        label: "Modo",
        type: "list-single",
        required: true,
        options: [
          { label: "on", value: "on" },
          { label: "off", value: "off" },
          { label: "status", value: "status" },
        ],
        default: "status",
      },
      {
        name: "minutes",
        label: "Minutos",
        type: "text-single",
        required: false,
        default: String(DEFAULT_BYPASS_MINUTES),
      },
    ],
    mutating: true,
    handler: async (formParams, ctx): Promise<ActionResult> => {
      const mode = (formParams.mode || "status").trim().toLowerCase();
      if (mode !== "on" && mode !== "off" && mode !== "status") {
        throw new Error(`Modo invalido: ${formParams.mode}. Usa on, off o status.`);
      }

      if (!ctx?.fromJid) {
        return "No se puede resolver la sesion: falta el JID del remitente.";
      }

      const route = resolveRoute({ account, cfg, fromJid: ctx.fromJid });
      const existing = activeBypasses.get(route.sessionKey);
      const nowMs = Date.now();

      if (mode === "status") {
        if (!existing) {
          return { text: "Elevated: inactivo para esta conversacion.", fields: [{ var: "active", value: "false" }] };
        }
        return {
          text: `Elevated: activo, quedan ${formatRemaining(existing.expiresAtMs, nowMs)}.`,
          fields: [
            { var: "active", value: "true" },
            { var: "scope", value: "session" },
            { var: "mode", value: "on" },
            { var: "expires-at-ms", value: String(existing.expiresAtMs) },
            {
              var: "remaining-seconds",
              value: String(Math.max(0, Math.round((existing.expiresAtMs - nowMs) / 1000))),
            },
          ],
        };
      }

      if (!isAuthorized(account, ctx)) {
        throw new Error("not-authorized");
      }

      if (mode === "off") {
        if (!existing) return "Elevated: ya estaba inactivo para esta conversacion.";
        await revertBypass({
          agentId: route.agentId,
          sessionKey: existing.sessionKey,
          previousElevatedLevel: existing.previousElevatedLevel,
          timer: existing.timer,
        });
        return "Elevated: desactivado. elevatedLevel restaurado.";
      }

      // mode === "on"
      const requestedMinutes = Number.parseInt(formParams.minutes ?? "", 10);
      const minutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0
        ? Math.min(requestedMinutes, MAX_BYPASS_MINUTES)
        : DEFAULT_BYPASS_MINUTES;
      const clampNotice = Number.isFinite(requestedMinutes) && requestedMinutes > MAX_BYPASS_MINUTES
        ? ` (ajustado al maximo de ${MAX_BYPASS_MINUTES})`
        : "";

      // A fresh activation on top of an already-active bypass replaces it:
      // cancel the old timer/entry first so we don't leak a stale timeout
      // that would revert to the WRONG previous value later, and so the
      // "previous" we capture below is the true pre-bypass state, not the
      // already-relaxed one.
      if (existing) {
        clearTimeout(existing.timer);
        activeBypasses.delete(route.sessionKey);
      }

      const currentEntry = getSessionEntry({ agentId: route.agentId, sessionKey: route.sessionKey });
      const previousElevatedLevel = existing ? existing.previousElevatedLevel : currentEntry?.elevatedLevel ?? undefined;

      const expiresAtMs = nowMs + minutes * 60_000;
      const timer = setTimeout(() => {
        const entry = activeBypasses.get(route.sessionKey);
        if (!entry) return; // already reverted manually
        void revertBypass({
          agentId: route.agentId,
          sessionKey: entry.sessionKey,
          previousElevatedLevel: entry.previousElevatedLevel,
        }).catch(() => {
          // Best-effort: if this fails, the session stays elevated until a
          // manual "off", a future bypass replacing it, or the startup
          // sweep on the next process start (the persisted record survives
          // even if this in-memory revert failed).
        });
      }, minutes * 60_000);

      activeBypasses.set(route.sessionKey, {
        sessionKey: route.sessionKey,
        previousElevatedLevel,
        expiresAtMs,
        timer,
      });

      await patchSessionEntry({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        update: (entry) => ({
          elevatedLevel: BYPASS_ELEVATED_LEVEL,
          pluginExtensions: {
            ...entry.pluginExtensions,
            [PLUGIN_NAMESPACE]: {
              ...entry.pluginExtensions?.[PLUGIN_NAMESPACE],
              [BYPASS_EXTENSION_KEY]: {
                expiresAtMs,
                previousElevatedLevel: previousElevatedLevel ?? null,
              } satisfies PersistedBypass,
            },
          },
        }),
      });

      return [
        `Elevated: activado por ${minutes} min${clampNotice}.`,
        "Alcance: solo esta conversacion, no todo el agente.",
        "Se revierte solo al expirar, o con elevated off.",
      ].join("\n");
    },
  };
}
