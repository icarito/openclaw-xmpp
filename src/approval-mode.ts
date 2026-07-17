// Host-side XMPP command for OpenClaw exec approval mode.
//
// This intentionally edits config only; it does not run an agent turn or shell
// command, so changing the mode cannot itself create an approval loop.
import fs from "node:fs";
import path from "node:path";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { ActionContext, XmppAction } from "./actions.js";
import { normalizeXmppAllowEntry } from "./normalize.js";
import type { CoreConfig } from "./types.js";

const VALID_MODES = ["status", "ask", "auto", "full", "deny"] as const;
type ApprovalMode = (typeof VALID_MODES)[number];

const AUTO_REVIEWER_MODEL = "kilo/deepseek-v4-flash";
const AUTO_REVIEWER_TIMEOUT_MS = 15_000;
const AUTO_SAFE_BINS = ["ls", "pwd", "whoami", "id", "date", "uname", "df", "du", "stat", "ps"];

function modeFromRaw(raw: string | undefined): ApprovalMode {
  const mode = (raw || "status").trim().toLowerCase();
  if (mode === "query" || mode === "estado") return "status";
  if (mode === "on" || mode === "enable" || mode === "enabled") return "auto";
  if (mode === "approve" || mode === "auto-approve" || mode === "safe") return "auto";
  if (mode === "bypass" || mode === "never") return "full";
  if (mode === "always" || mode === "manual") return "ask";
  if (mode === "disable" || mode === "disabled" || mode === "off") return "ask";
  if (mode === "block" || mode === "blocked") return "deny";
  if ((VALID_MODES as readonly string[]).includes(mode)) return mode as ApprovalMode;
  throw new Error(`Modo invalido: ${raw}. Usa status, ask, auto, full o deny.`);
}

function normalizeBare(raw: string | undefined): string {
  return normalizeXmppAllowEntry(raw ?? "") || "";
}

function isAuthorized(account: ResolvedXmppAccount, ctx?: ActionContext): boolean {
  const sender = normalizeBare(ctx?.fromJid);
  if (!sender) return false;
  return (account.config.allowFrom ?? []).some((entry) => {
    const normalized = normalizeBare(String(entry));
    return normalized === "*" || normalized === sender;
  });
}

function configPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR no esta definido; no se puede ubicar openclaw.json.");
  }
  return path.join(stateDir, "openclaw.json");
}

function readConfigFile(): { file: string; config: Record<string, unknown> } {
  const file = configPath();
  const raw = fs.readFileSync(file, "utf8");
  return { file, config: JSON.parse(raw) as Record<string, unknown> };
}

function getExec(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const tools = config.tools as Record<string, unknown> | undefined;
  return tools?.exec as Record<string, unknown> | undefined;
}

function describeExec(config: Record<string, unknown>): string {
  const exec = getExec(config);
  if (!exec) return "mode=ask";
  if (typeof exec.mode === "string") return `mode=${exec.mode}`;
  const parts = [
    typeof exec.security === "string" ? `security=${exec.security}` : undefined,
    typeof exec.ask === "string" ? `ask=${exec.ask}` : undefined,
  ].filter(Boolean);
  const reviewer = exec.reviewer as Record<string, unknown> | undefined;
  if (typeof reviewer?.model === "string") parts.push(`reviewer=${reviewer.model}`);
  if (Array.isArray(exec.safeBins) && exec.safeBins.length > 0) parts.push(`safeBins=${exec.safeBins.join(",")}`);
  return parts.join(" ") || "mode=ask";
}

function setExecPreset(config: Record<string, unknown>, mode: Exclude<ApprovalMode, "status">): void {
  const tools = (config.tools && typeof config.tools === "object" ? config.tools : {}) as Record<string, unknown>;
  const exec = (tools.exec && typeof tools.exec === "object" ? tools.exec : {}) as Record<string, unknown>;
  delete exec.mode;
  delete exec.security;
  delete exec.ask;
  delete exec.reviewer;
  delete exec.safeBins;

  if (mode === "auto") {
    exec.security = "allowlist";
    exec.ask = "on-miss";
    exec.reviewer = { model: AUTO_REVIEWER_MODEL, timeoutMs: AUTO_REVIEWER_TIMEOUT_MS };
    exec.safeBins = AUTO_SAFE_BINS;
  } else {
    exec.mode = mode;
  }

  tools.exec = exec;
  config.tools = tools;
}

function writeConfigFile(file: string, config: Record<string, unknown>): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backup = `${file}.bak-approval-mode-${stamp}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Validate the exact bytes before replacing the live config.
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, file);
  return backup;
}

function describeMode(mode: string): string {
  if (mode === "ask") return "ask: todo exec/elevated pide aprobacion.";
  if (mode === "auto") {
    return [
      "auto: allowlist conservadora + reviewer flash.",
      "Comandos triviales pasan por allowlist; lo demas lo revisa flash y cae a aprobacion humana si hay riesgo, timeout o duda.",
    ].join(" ");
  }
  if (mode === "full") return "full: bypass amplio; usalo como ventana corta de emergencia.";
  if (mode === "deny") return "deny: exec/elevated bloqueado por policy del core.";
  return `${mode}: modo no documentado por esta extension; se conserva tal cual.`;
}

export function buildApprovalModeAction(params: {
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  node?: string;
  name?: string;
  description?: string;
}): XmppAction {
  const { account, cfg } = params;
  return {
    node: params.node ?? "approval-mode",
    name: params.name ?? "Approvals: mode / bypass",
    description:
      params.description ??
      "Consulta o cambia la policy exec: ask, auto (allowlist + reviewer flash), full o deny.",
    params: [
      {
        name: "mode",
        label: "Modo",
        type: "list-single",
        required: true,
        options: [
          { label: "status", value: "status" },
          { label: "on (auto)", value: "on" },
          { label: "off (ask)", value: "off" },
          { label: "ask", value: "ask" },
          { label: "auto", value: "auto" },
          { label: "full", value: "full" },
          { label: "deny", value: "deny" },
        ],
        default: "status",
      },
    ],
    mutating: true,
    handler: async (formParams, ctx) => {
      const requested = modeFromRaw(formParams.mode);
      const fileMode = (() => {
        try {
          return describeExec(readConfigFile().config);
        } catch {
          return cfg.tools?.exec?.mode ? `mode=${cfg.tools.exec.mode}` : "mode=ask";
        }
      })();

      if (requested === "status") {
        return `Policy exec actual: ${String(fileMode)}`;
      }

      if (!isAuthorized(account, ctx)) {
        throw new Error("not-authorized");
      }

      const { file, config } = readConfigFile();
      const before = describeExec(config);
      setExecPreset(config, requested);
      const after = describeExec(config);
      const backup = writeConfigFile(file, config);
      return [
        `tools.exec: ${before} -> ${after}`,
        `Backup: ${backup}`,
        "Requiere reiniciar claudio-w-openclaw.service para aplicar al runtime actual.",
        requested === "full"
          ? "Advertencia: full es bypass amplio; vuelve a auto o ask al terminar."
          : `Nuevo modo: ${describeMode(requested)}`,
      ].join("\n");
    },
  };
}
