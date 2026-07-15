// Xmpp helper module supports config schema behavior.
import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { xmppChannelConfigUiHints } from "./config-ui-hints.js";

const XmppGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const XmppAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    jid: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    service: z.string().optional(),
    resource: z.string().optional(),
    mucDomain: z.string().optional(),
    mucRooms: z.array(z.string()).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), XmppGroupSchema.optional()).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    contextWindowTokens: z.number().int().positive().optional(),
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

const XmppAccountSchema = XmppAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.xmpp.dmPolicy="open" requires channels.xmpp.allowFrom to include "*"',
  });
});

const XmppConfigSchema = XmppAccountSchemaBase.extend({
  accounts: z.record(z.string(), XmppAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.xmpp.dmPolicy="open" requires channels.xmpp.allowFrom to include "*"',
  });
});

export const XmppChannelConfigSchema = buildChannelConfigSchema(XmppConfigSchema, {
  uiHints: xmppChannelConfigUiHints,
});
