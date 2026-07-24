// Xmpp plugin module implements policy behavior.
import type { XmppChannelConfig } from "./types.js";

type GroupToolPolicyConfig = NonNullable<XmppChannelConfig["tools"]>;
type ScopeEntry = Pick<XmppChannelConfig, "requireMention" | "tools">;
type ScopeTree = {
  defaults?: ScopeEntry;
  scopes?: Record<string, ScopeEntry>;
};

function resolveKey(tree: ScopeTree, target: string): string | null {
  const lower = target.toLowerCase();
  for (const key of Object.keys(tree.scopes ?? {})) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

type XmppGroupMatch = {
  allowed: boolean;
  groupConfig?: XmppChannelConfig;
  wildcardConfig?: XmppChannelConfig;
  hasConfiguredGroups: boolean;
};

function resolveXmppGroupScope(params: {
  groups?: Record<string, XmppChannelConfig>;
  target: string;
}) {
  const { "*": wildcard, ...groups } = params.groups ?? {};
  const project = (entry: XmppChannelConfig) => ({
    requireMention: entry.requireMention,
    tools: entry.tools,
  });
  const tree: ScopeTree = {
    defaults: wildcard ? project(wildcard) : undefined,
    scopes: Object.fromEntries(Object.entries(groups).map(([key, entry]) => [key, project(entry)])),
  };
  const key = resolveKey(tree, params.target);
  return { tree, path: key ? [key] : [] };
}

function resolveRequireMention(tree: ScopeTree, path: string[]): boolean {
  const scoped = path[0] ? tree.scopes?.[path[0]] : undefined;
  return scoped?.requireMention ?? tree.defaults?.requireMention ?? true;
}

export function resolveXmppGroupMatch(params: {
  groups?: Record<string, XmppChannelConfig>;
  target: string;
}): XmppGroupMatch {
  const { path } = resolveXmppGroupScope(params);
  const key = path[0];
  const groupConfig = key ? params.groups?.[key] : undefined;
  const wildcardConfig = params.groups?.["*"];
  return {
    allowed: Boolean(groupConfig ?? wildcardConfig),
    groupConfig,
    wildcardConfig,
    hasConfiguredGroups: Object.keys(params.groups ?? {}).length > 0,
  };
}

export function resolveXmppGroupRequireMention(params: {
  groups?: Record<string, XmppChannelConfig>;
  target: string;
}): boolean {
  const { tree, path } = resolveXmppGroupScope(params);
  return resolveRequireMention(tree, path);
}

export function resolveXmppGroupToolPolicy(params: {
  groups?: Record<string, XmppChannelConfig>;
  target: string;
}): GroupToolPolicyConfig | undefined {
  const { tree, path } = resolveXmppGroupScope(params);
  const scoped = path[0] ? tree.scopes?.[path[0]] : undefined;
  return scoped?.tools ?? tree.defaults?.tools;
}
