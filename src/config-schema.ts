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
import {
  DEFAULT_BURST_MAX_MESSAGES,
  DEFAULT_BURST_MAX_TURNS,
  DEFAULT_BURST_PAUSED_MS,
  DEFAULT_BURST_WINDOW_MS,
  DEFAULT_DEBOUNCE_WINDOW_MS,
  DEFAULT_DISPATCH_DEDUPE_TTL_MS,
  DEFAULT_HISTORY_MAX_PAGES,
  DEFAULT_HISTORY_MUC_MAX_STANZAS,
  DEFAULT_HISTORY_WINDOW_MS,
  DEFAULT_SPOOL_MAX_AGE_MS,
  DEFAULT_SPOOL_MAX_ATTEMPTS,
} from "./config-defaults.js";
import { xmppChannelConfigUiHints } from "./config-ui-hints.js";

const XmppInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);
const XmppCapabilitiesSchema = z.union([
  z.array(z.string()),
  z.object({ inlineButtons: XmppInlineButtonsScopeSchema.optional() }).strict(),
]);

const XmppReliabilitySchema = z
  .object({
    debounce: z
      .object({
        enabled: z.boolean().optional().default(true),
        windowMs: z.number().int().positive().optional().default(DEFAULT_DEBOUNCE_WINDOW_MS),
      })
      .strict()
      .optional(),
    burstBreaker: z
      .object({
        enabled: z.boolean().optional().default(true),
        maxTurns: z.number().int().positive().optional().default(DEFAULT_BURST_MAX_TURNS),
        maxMessages: z.number().int().positive().optional().default(DEFAULT_BURST_MAX_MESSAGES),
        windowMs: z.number().int().positive().optional().default(DEFAULT_BURST_WINDOW_MS),
        pausedMs: z.number().int().positive().optional().default(DEFAULT_BURST_PAUSED_MS),
      })
      .strict()
      .optional(),
    spool: z
      .object({
        enabled: z.boolean().optional().default(true),
        resendOnReconnect: z.boolean().optional().default(true),
        maxAgeMs: z.number().int().positive().optional().default(DEFAULT_SPOOL_MAX_AGE_MS),
        maxAttempts: z.number().int().positive().optional().default(DEFAULT_SPOOL_MAX_ATTEMPTS),
      })
      .strict()
      .optional(),
    dispatchDedupe: z
      .object({
        enabled: z.boolean().optional().default(true),
        ttlMs: z.number().int().positive().optional().default(DEFAULT_DISPATCH_DEDUPE_TTL_MS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const XmppHistorySchema = z
  .object({
    catchup: z.boolean().optional().default(false),
    spawnTurns: z.boolean().optional().default(false),
    windowMs: z.number().int().positive().optional().default(DEFAULT_HISTORY_WINDOW_MS),
    maxPages: z.number().int().positive().optional().default(DEFAULT_HISTORY_MAX_PAGES),
    mucMaxStanzas: z.number().int().nonnegative().optional().default(DEFAULT_HISTORY_MUC_MAX_STANZAS),
  })
  .strict()
  .optional();

const XmppHooksSchema = z
  .object({
    pepEvents: z.boolean().optional().default(false),
    reactions: z.boolean().optional().default(false),
    receipts: z.boolean().optional().default(true),
  })
  .strict()
  .optional();


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
    capabilities: XmppCapabilitiesSchema.optional(),
    markdown: MarkdownConfigSchema,
    contextWindowTokens: z.number().int().positive().optional(),
    streamManagement: z
      .object({
        enabled: z.boolean().optional(),
        resumptionMaxSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    omemo: z
      .object({
        enabled: z.boolean().optional(),
        deviceLabel: z.string().optional(),
        protocol: z.enum(["legacy", "v2", "dual"]).optional(),
        requireEncryption: z.boolean().optional(),
        mirrorInbound: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reliability: XmppReliabilitySchema,
    history: XmppHistorySchema,
    hooks: XmppHooksSchema,
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

// Cast needed: buildChannelConfigSchema's declared param type comes from
// openclaw's internally vendored zod build (config-schema-*.d.ts imports
// ZodType from its own bundled schemas-*.js), a structurally distinct
// nominal type from the "zod" package this plugin depends on directly, even
// though both are zod 4 at runtime. Values are compatible; only TS's
// nominal typing of the two vendored copies is not.
export const XmppChannelConfigSchema = buildChannelConfigSchema(XmppConfigSchema as never, {
  uiHints: xmppChannelConfigUiHints,
});
