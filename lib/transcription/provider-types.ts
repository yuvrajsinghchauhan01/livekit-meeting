export type TranscriptionProviderName = "openai" | "voxtral";

export interface NormalizedTranscriptionSegment {
  start?: number;
  end?: number;
  text?: string;
  confidence?: number;
  avg_logprob?: number;
}

export interface NormalizedTranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: NormalizedTranscriptionSegment[];
  provider: TranscriptionProviderName;
  model: string;
  raw?: unknown;
}

export interface TranscriptionRequest {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  prompt?: string;
  timestampGranularities: Array<"segment">;
  diarize?: boolean;
}

export interface TranscriptionProviderAdapter {
  name: TranscriptionProviderName;
  getModel(): string;
  transcribe(request: TranscriptionRequest): Promise<NormalizedTranscriptionResponse>;
}
