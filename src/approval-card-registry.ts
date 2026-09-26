// Xmpp plugin module implements the persistent registry of active approval
// cards (change xmpp-first-class-channel, tareas 6.1/6.2). Cards issued by the
// native approval runtime are keyed by their stanza id; persisting them lets a
// new process reconcile cards that crossed a restart, closing them with an
// XEP-0308 edit ("expirada/reconciliada") instead of leaving zombie cards that
// nobody can act on. It does not change the XEP-0004 result contract nor the
// expires-at-ms metadata.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type XmppApprovalCard = {
  approvalId: string;
  stanzaId: string;
  accountId: string;
  jid: string;
  /** Base XEP-0050 node prefix; per-option nodes are `cmd:<stanzaId>:<index>`. */
  node: string;
  expiresAt: number;
  createdAt: number;
  sessionKey?: string;
  commandText?: string;
};

export type ApprovalCardReconcileResult = {
  reconciled: number;
  failed: number;
};

export type ApprovalCardRegistryOptions = {
  path: string | null;
};

type ApprovalCardFile = { version: 1; cards: XmppApprovalCard[] };

export function resolveApprovalCardPath(accountId: string): string | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) return null;
  return join(stateDir, "channel-cache", "xmpp", `${accountId}-approval-cards.json`);
}

export class ApprovalCardRegistry {
  private readonly path: string | null;
  private cards = new Map<string, XmppApprovalCard>();
  private loaded = false;

  constructor(options: ApprovalCardRegistryOptions) {
    this.path = options.path;
  }

  register(card: XmppApprovalCard): void {
    this.ensureLoaded();
    this.cards.set(card.stanzaId, card);
    this.persist();
  }

  get(stanzaId: string): XmppApprovalCard | undefined {
    this.ensureLoaded();
    return this.cards.get(stanzaId);
  }

  list(): XmppApprovalCard[] {
    this.ensureLoaded();
    return [...this.cards.values()];
  }

  removeByStanza(stanzaId: string): boolean {
    this.ensureLoaded();
    const removed = this.cards.delete(stanzaId);
    if (removed) this.persist();
    return removed;
  }

  removeByApprovalId(approvalId: string): boolean {
    this.ensureLoaded();
    let removed = false;
    for (const [stanzaId, card] of this.cards) {
      if (card.approvalId === approvalId) {
        this.cards.delete(stanzaId);
        removed = true;
      }
    }
    if (removed) this.persist();
    return removed;
  }

  stats(): { active: number } {
    this.ensureLoaded();
    return { active: this.cards.size };
  }

  /**
   * Close every card that survived into this process. Any persisted card
   * crossed a restart, so its pending approval can no longer be resolved: it
   * is edited closed and dropped. A clean start (no cards) is silent.
   */
  async reconcile(params: {
    now?: number;
    editCard: (card: XmppApprovalCard, text: string) => Promise<void>;
    releaseSessionKey?: (sessionKey: string) => void;
    log?: { info?: (message: string) => void; warn?: (message: string) => void };
  }): Promise<ApprovalCardReconcileResult> {
    this.ensureLoaded();
    const cards = [...this.cards.values()];
    if (cards.length === 0) return { reconciled: 0, failed: 0 };

    let reconciled = 0;
    let failed = 0;
    for (const card of cards) {
      const text = card.commandText
        ? `⌛ Aprobación expirada (reconciliada tras reinicio) — ${card.commandText}`
        : "⌛ Aprobación expirada (reconciliada tras reinicio)";
      try {
        await params.editCard(card, text);
        reconciled += 1;
      } catch (error) {
        failed += 1;
        params.log?.warn?.(
          `xmpp approvals: fallo reconciliando card ${card.stanzaId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Drop it either way: a card whose edit failed is still orphaned, and
      // retrying forever would only replay noise.
      this.cards.delete(card.stanzaId);
      if (card.sessionKey) params.releaseSessionKey?.(card.sessionKey);
    }
    this.persist();
    return { reconciled, failed };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as ApprovalCardFile;
      for (const card of raw.cards ?? []) {
        if (typeof card?.stanzaId !== "string" || typeof card.jid !== "string") continue;
        this.cards.set(card.stanzaId, {
          approvalId: typeof card.approvalId === "string" ? card.approvalId : "",
          stanzaId: card.stanzaId,
          accountId: typeof card.accountId === "string" ? card.accountId : "",
          jid: card.jid,
          node: typeof card.node === "string" ? card.node : `cmd:${card.stanzaId}`,
          expiresAt: typeof card.expiresAt === "number" ? card.expiresAt : 0,
          createdAt: typeof card.createdAt === "number" ? card.createdAt : Date.now(),
          ...(typeof card.sessionKey === "string" ? { sessionKey: card.sessionKey } : {}),
          ...(typeof card.commandText === "string" ? { commandText: card.commandText } : {}),
        });
      }
    } catch {
      // A corrupt registry must not block approvals; it is rewritten on the
      // next register.
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload: ApprovalCardFile = { version: 1, cards: [...this.cards.values()] };
      writeFileSync(`${this.path}.tmp`, JSON.stringify(payload, null, 2) + "\n");
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // Best-effort: losing the registry only degrades reconciliation.
    }
  }
}

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.approvalCards");

function registry(): Map<string, ApprovalCardRegistry> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, ApprovalCardRegistry>;
}

export function getApprovalCardRegistry(
  accountId: string,
  options?: Partial<ApprovalCardRegistryOptions>,
): ApprovalCardRegistry {
  const existing = registry().get(accountId);
  if (existing) return existing;
  const created = new ApprovalCardRegistry({
    path: options?.path ?? resolveApprovalCardPath(accountId),
  });
  registry().set(accountId, created);
  return created;
}

export function clearApprovalCardRegistry(accountId: string): void {
  registry().delete(accountId);
}
