// Host-side XMPP command for a TEMPORARY, session-scoped exec approval
// bypass. Distinct from approval-mode.ts: that command edits openclaw.json
// on disk and requires a gateway restart to apply (agent-wide, persistent).
// This command patches the invoking session's execSecurity/execAsk directly
// in the session store (getSessionEntry/patchSessionEntry from
// openclaw/plugin-sdk/session-store-runtime), which the core re-reads every
// turn via resolveExecDefaults -- no restart, no config file write, and
// scoped to one session rather than the whole agent.
//
// The auto-reversion timer lives in this module's in-memory state (a Map),
// not in the session store itself: if the gateway restarts while a bypass
// is active, the timer is lost but the relaxed execSecurity/execAsk value
// already persisted in the session store survives (documented risk, see
// openspec change xmpp-approval-bypass-and-fallback-cleanup design.md D3).
import { getSessionEntry, patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { ActionContext, XmppAction } from "./actions.js";
import { normalizeXmppAllowEntry } from "./normalize.js";
import type { CoreConfig } from "./types.js";

const DEFAULT_BYPASS_MINUTES = 10;
const MAX_BYPASS_MINUTES = 60;

const BYPASS_EXEC_SECURITY = "full";
const BYPASS_EXEC_ASK = "off";

type BypassEntry = {
  sessionKey: string;
  previousExecSecurity: string | undefined;
  previousExecAsk: string | undefined;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
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

/** Reverts one session's exec policy to its pre-bypass value and clears the
 *  tracked entry. Shared by mode=off, the expiry timer, and (implicitly) a
 *  fresh mode=on that replaces an existing entry -- so there is exactly one
 *  code path that performs a reversion. */
async function revertBypass(params: { agentId: string; entry: BypassEntry }): Promise<void> {
  clearTimeout(params.entry.timer);
  activeBypasses.delete(params.entry.sessionKey);
  await patchSessionEntry({
    agentId: params.agentId,
    sessionKey: params.entry.sessionKey,
    update: () => ({
      execSecurity: params.entry.previousExecSecurity,
      execAsk: params.entry.previousExecAsk,
    }),
  });
}

export function buildApprovalBypassAction(params: {
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  node?: string;
  name?: string;
  description?: string;
}): XmppAction {
  const { account, cfg } = params;
  return {
    node: params.node ?? "approval-bypass",
    name: params.name ?? "Approvals: temporary bypass",
    description:
      params.description ??
      "Relaja las aprobaciones de exec SOLO para esta conversación, por N minutos (default "
        + `${DEFAULT_BYPASS_MINUTES}, máximo ${MAX_BYPASS_MINUTES}). Se revierte solo al expirar, `
        + "sin reiniciar el gateway. Para bypass permanente de todo el agente usa approval-mode full.",
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
    handler: async (formParams, ctx) => {
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
        if (!existing) return "Bypass: inactivo para esta conversacion.";
        return `Bypass: activo, quedan ${formatRemaining(existing.expiresAtMs, nowMs)}.`;
      }

      if (!isAuthorized(account, ctx)) {
        throw new Error("not-authorized");
      }

      if (mode === "off") {
        if (!existing) return "Bypass: ya estaba inactivo para esta conversacion.";
        await revertBypass({ agentId: route.agentId, entry: existing });
        return "Bypass: desactivado. Policy de exec restaurada.";
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
      const previousExecSecurity = existing ? existing.previousExecSecurity : currentEntry?.execSecurity;
      const previousExecAsk = existing ? existing.previousExecAsk : currentEntry?.execAsk;

      const expiresAtMs = nowMs + minutes * 60_000;
      const timer = setTimeout(() => {
        const entry = activeBypasses.get(route.sessionKey);
        if (!entry) return; // already reverted manually
        void revertBypass({ agentId: route.agentId, entry }).catch(() => {
          // Best-effort: if this fails, the session stays relaxed until a
          // manual "off" or a future bypass replaces it. No retry loop --
          // see design.md risk on gateway restarts for the same accepted
          // failure mode.
        });
      }, minutes * 60_000);

      activeBypasses.set(route.sessionKey, {
        sessionKey: route.sessionKey,
        previousExecSecurity,
        previousExecAsk,
        expiresAtMs,
        timer,
      });

      await patchSessionEntry({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        update: () => ({
          execSecurity: BYPASS_EXEC_SECURITY,
          execAsk: BYPASS_EXEC_ASK,
        }),
      });

      return [
        `Bypass: activado por ${minutes} min${clampNotice}.`,
        "Alcance: solo esta conversacion, no todo el agente.",
        "Se revierte solo al expirar, o con approval-bypass off.",
      ].join("\n");
    },
  };
}
