import { Mistral } from "@mistralai/mistralai";
import {
  NormalizedTranscriptionResponse,
  TranscriptionProviderAdapter,
  TranscriptionRequest,
} from "../provider-types";

const MISTRAL_TRANSCRIPTION_MODEL =
  process.env.MISTRAL_TRANSCRIPTION_MODEL || "voxtral-mini-latest";
const MISTRAL_DIARIZE = process.env.MISTRAL_TRANSCRIPTION_DIARIZE === "true";

let mistralClient: Mistral | null = null;

function getMistralClient() {
  if (mistralClient) return mistralClient;

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY is not configured");

  mistralClient = new Mistral({ apiKey });
  return mistralClient;
}

export const voxtralTranscriptionProvider: TranscriptionProviderAdapter = {
  name: "voxtral",
  getModel() {
    return MISTRAL_TRANSCRIPTION_MODEL;
  },
  async transcribe(request: TranscriptionRequest): Promise<NormalizedTranscriptionResponse> {
    const client = getMistralClient();
    const response = await client.audio.transcriptions.complete({
      model: MISTRAL_TRANSCRIPTION_MODEL,
      file: new Blob([new Uint8Array(request.buffer)], {
        type: request.mimeType,
      }),
      diarize: request.diarize ?? MISTRAL_DIARIZE,
      timestampGranularities: request.timestampGranularities,
    });

    return {
      provider: "voxtral",
      model: response.model || MISTRAL_TRANSCRIPTION_MODEL,
      text: response.text,
      language: response.language || undefined,
      segments: (response.segments || []).map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        confidence:
          typeof segment.score === "number" ? Number(segment.score.toFixed(4)) : undefined,
      })),
      raw: response,
    };
  },
};
