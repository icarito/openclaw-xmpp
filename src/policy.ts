// Xmpp plugin module implements policy behavior.
import {
  resolveScopeKeyCaseInsensitive,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import type { XmppChannelConfig } from "./types.js";

function resolveKey(tree: ScopeTree, target: string): string | null {
  if (typeof resolveScopeKeyCaseInsensitive === "function") {
    return resolveScopeKeyCaseInsensitive(tree, target);
  }
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
  return resolveScopeRequireMention({ tree, path });
}

export function resolveXmppGroupToolPolicy(params: {
  groups?: Record<string, XmppChannelConfig>;
  target: string;
}): GroupToolPolicyConfig | undefined {
  const { tree, path } = resolveXmppGroupScope(params);
  return resolveScopeToolsPolicy({ tree, path });
}
