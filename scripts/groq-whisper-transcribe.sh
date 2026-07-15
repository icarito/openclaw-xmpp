#!/usr/bin/env bash
# Audio transcription command for openclaw.json's audio.transcription.command.
# Called by the OpenClaw gateway as: groq-whisper-transcribe.sh <MediaPath>
# Must print the transcript text to stdout and nothing else on success.
#
# Requires GROQ_API_KEY in the gateway process environment.
set -euo pipefail

media_path="${1:?usage: groq-whisper-transcribe.sh <MediaPath>}"

if [ -z "${GROQ_API_KEY:-}" ]; then
  echo "groq-whisper-transcribe.sh: GROQ_API_KEY is not set" >&2
  exit 1
fi

if [ ! -f "$media_path" ]; then
  echo "groq-whisper-transcribe.sh: file not found: $media_path" >&2
  exit 1
fi

response="$(curl -sS --fail-with-body \
  https://api.groq.com/openai/v1/audio/transcriptions \
  -H "Authorization: Bearer ${GROQ_API_KEY}" \
  -F "file=@${media_path}" \
  -F "model=whisper-large-v3-turbo")" || {
  echo "groq-whisper-transcribe.sh: request failed: $response" >&2
  exit 1
}

text="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["text"])' 2>/dev/null)" || {
  echo "groq-whisper-transcribe.sh: could not parse response: $response" >&2
  exit 1
}

printf '%s' "$text"
