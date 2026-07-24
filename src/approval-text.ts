// Shared compact text builders for exec approval cards. Used by both
// delivery routes (channel.ts's forwarder-based render.exec.buildPendingPayload
// and approval-handler.runtime.ts's native buildXmppPendingPayload) so the
// fallback text a client sees does not depend on which route delivered it.
//
// Prior to this module, only the forwarder route called
// buildCompactExecApprovalText; the native route used the core's raw
// payload.text, which wraps command/warning fields in fenced code blocks
// (formatFencedCodeBlock) that render as empty triple backticks when those
// fields are empty. See openspec change
// xmpp-approval-bypass-and-fallback-cleanup for the investigation.

const APPROVAL_CARD_TITLE_MAX = 80;
const APPROVAL_CARD_COMMAND_MAX = 220;

/** Título de una sola línea para la card de aprobación: el comando en sí, no
 * un genérico "OpenClaw" ni el bloque de texto verbose del fallback. */
export function buildApprovalCardTitle(commandText: string): string {
  const oneLine = commandText.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Approval required";
  if (oneLine.length <= APPROVAL_CARD_TITLE_MAX) return oneLine;
  return `${oneLine.slice(0, APPROVAL_CARD_TITLE_MAX - 1)}…`;
}

export function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function formatApprovalExpiry(expiresAtMs: number | undefined, nowMs: number): string | null {
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return null;
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)}m`;
}

/**
 * Cuerpo COMPACTO de la solicitud de aprobación. Reemplaza el texto verbose
 * del core (Run:/Other options:/Full id:/policy...) que en un cliente XMPP de
 * texto ocupaba una pantalla entera. Reglas:
 * - el comando va primero y truncado a una línea razonable;
 * - una sola línea de instrucción de respuesta con el slug corto (el core
 *   acepta el slug de 8 chars en /approve);
 * - los botones (cuando el cliente los soporta) salen de presentation, no de
 *   este texto, así que esto es sólo el fallback legible.
 */
export function buildCompactExecApprovalText(params: {
  command: string;
  cwd?: string | null;
  warningText?: string | null;
  approvalSlug: string;
  allowedDecisions: readonly string[];
  expiresAtMs?: number;
  nowMs: number;
}): string {
  const lines: string[] = [];
  const warning = params.warningText?.trim();
  if (warning) {
    lines.push(`⚠️ ${truncateOneLine(warning, 200)}`);
  }
  lines.push(`🔒 ${truncateOneLine(params.command, APPROVAL_CARD_COMMAND_MAX)}`);
  const info: string[] = [];
  if (params.cwd?.trim()) {
    info.push(`cwd ${truncateOneLine(params.cwd, 60)}`);
  }
  const expiry = formatApprovalExpiry(params.expiresAtMs, params.nowMs);
  if (expiry) {
    info.push(`caduca en ${expiry}`);
  }
  if (info.length > 0) {
    lines.push(info.join(" · "));
  }
  const decisions = params.allowedDecisions.length > 0
    ? params.allowedDecisions.join(" | ")
    : "allow-once | deny";
  lines.push(`Responde: /approve ${params.approvalSlug} ${decisions}`);
  return lines.join("\n");
}
