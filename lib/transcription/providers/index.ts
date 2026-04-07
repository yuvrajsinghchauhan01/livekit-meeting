import {
  TranscriptionProviderAdapter,
  TranscriptionProviderName,
} from "../provider-types";
import { openAITranscriptionProvider } from "./openai";
import { voxtralTranscriptionProvider } from "./voxtral";

const providerRegistry: Record<
  TranscriptionProviderName,
  TranscriptionProviderAdapter
> = {
  openai: openAITranscriptionProvider,
  voxtral: voxtralTranscriptionProvider,
};

export function resolveTranscriptionProviderName(
  provider?: string
): TranscriptionProviderName {
  const raw = (provider || process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase();
  if (raw === "openai" || raw === "voxtral") return raw;
  throw new Error(
    `Unsupported transcription provider '${provider}'. Supported providers: ${Object.keys(providerRegistry).join(", ")}`
  );
}

export function getTranscriptionProvider(provider?: string) {
  const resolved = resolveTranscriptionProviderName(provider);
  return providerRegistry[resolved];
}
