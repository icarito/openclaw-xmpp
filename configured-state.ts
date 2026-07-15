// Xmpp helper module supports configured state behavior.
export function hasXmppConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.XMPP_JID === "string" &&
    params.env.XMPP_JID.trim().length > 0 &&
    typeof params.env?.XMPP_PASSWORD === "string" &&
    params.env.XMPP_PASSWORD.trim().length > 0
  );
}
