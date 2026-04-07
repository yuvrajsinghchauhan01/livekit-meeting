import {
  NormalizedTranscriptionResponse,
  TranscriptionProviderAdapter,
  TranscriptionRequest,
} from "../provider-types";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";

function getOpenAIHeaders() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return { Authorization: `Bearer ${apiKey}` };
}

export const openAITranscriptionProvider: TranscriptionProviderAdapter = {
  name: "openai",
  getModel() {
    return OPENAI_TRANSCRIPTION_MODEL;
  },
  async transcribe(request: TranscriptionRequest): Promise<NormalizedTranscriptionResponse> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(request.buffer)], {
      type: request.mimeType,
    });

    form.append("file", blob, request.filename);
    form.append("model", OPENAI_TRANSCRIPTION_MODEL);
    form.append("response_format", "verbose_json");
    for (const granularity of request.timestampGranularities) {
      form.append("timestamp_granularities[]", granularity);
    }
    if (request.prompt?.trim()) {
      form.append("prompt", request.prompt);
    }

    const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: getOpenAIHeaders(),
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI transcription failed: ${response.status} ${text}`);
    }

    const payload = (await response.json()) as Omit<
      NormalizedTranscriptionResponse,
      "provider" | "model"
    >;

    return {
      ...payload,
      provider: "openai",
      model: OPENAI_TRANSCRIPTION_MODEL,
      raw: payload,
    };
  },
};
