// Transcripción preflight de audio entrante por XMPP. Sigue el mismo patrón
// que el canal Matrix (resolveMatrixPreflightAudioTranscript): resuelve el
// transcripto vía el runtime de media-understanding del core ANTES de
// despachar la respuesta del agente, y nunca deja que un fallo del
// proveedor tumbe el turno.
import { isAudioFileName, transcribeFirstAudio } from "openclaw/plugin-sdk/media-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const AUDIO_TRANSCRIPT_LABEL =
  "[Audio transcript (machine-generated, untrusted)]";

export function formatXmppAudioTranscript(transcript: string): string {
  return `${AUDIO_TRANSCRIPT_LABEL}: ${JSON.stringify(transcript)}`;
}

export function isXmppAudioAttachment(params: {
  path?: string;
  contentType?: string;
}): boolean {
  if (params.contentType?.toLowerCase().startsWith("audio/")) return true;
  if (params.path && isAudioFileName(params.path)) return true;
  return false;
}

export async function resolveXmppPreflightAudioTranscript(params: {
  mediaPath: string;
  mediaContentType?: string;
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  sessionKey?: string;
  log?: (line: string) => void;
}): Promise<string | undefined> {
  const audioConfig = params.cfg.tools?.media?.audio;
  if (!audioConfig?.enabled) return undefined;
  if (!isXmppAudioAttachment({ path: params.mediaPath, contentType: params.mediaContentType })) {
    return undefined;
  }
  try {
    return await transcribeFirstAudio({
      ctx: {
        MediaPaths: [params.mediaPath],
        MediaTypes: params.mediaContentType ? [params.mediaContentType] : undefined,
        Provider: "xmpp",
        Surface: "xmpp",
        OriginatingChannel: "xmpp",
        OriginatingTo: params.originatingTo,
        AccountId: params.accountId,
        SessionKey: params.sessionKey,
      },
      cfg: params.cfg,
    });
  } catch (err) {
    params.log?.(`xmpp: audio preflight transcription failed: ${String(err)}`);
    return undefined;
  }
}
