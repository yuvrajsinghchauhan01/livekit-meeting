import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const DEFAULT_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const DEFAULT_TRANSLATION_MODEL =
  process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini";
const TRANSCRIPT_DIR = "_transcripts";
const APP_METADATA_PREFIX = "APP_";
const CANONICAL_AUDIO_NAME = "audio.ogg";
const CANONICAL_METADATA_NAME = "metadata.json";
const WHISPER_CHUNK_SECONDS = Number(
  process.env.WHISPER_CHUNK_SECONDS || "45"
);
const VAD_SILENCE_NOISE = process.env.VAD_SILENCE_NOISE || "-35dB";
const VAD_MIN_SILENCE_SECONDS = Number(
  process.env.VAD_MIN_SILENCE_SECONDS || "0.6"
);
const VAD_MIN_SPEECH_MS = Number(process.env.VAD_MIN_SPEECH_MS || "400");
const VAD_PADDING_MS = Number(process.env.VAD_PADDING_MS || "200");
const VAD_MERGE_GAP_MS = Number(process.env.VAD_MERGE_GAP_MS || "700");
const NOISE_MIN_CONFIDENCE = Number(
  process.env.NOISE_MIN_CONFIDENCE || "0.52"
);
const NOISE_MAX_DURATION_MS = Number(
  process.env.NOISE_MAX_DURATION_MS || "2200"
);
const NOISE_MAX_CHARS = Number(process.env.NOISE_MAX_CHARS || "12");
const TRANSCRIPTION_HINTS = process.env.OPENAI_TRANSCRIPTION_HINTS || "";

const roomJobs = new Map<string, Promise<TranscriptionRunResult>>();

export function getAppMetadataKey(roomName: string, participantIdentity: string, trackSid: string) {
  return `recordings/${roomName}/${participantIdentity}/${APP_METADATA_PREFIX}${trackSid}.json`;
}

interface QueueRoomTranscriptionOptions {
  roomName: string;
  prefix?: string;
  force?: boolean;
  trigger: "manual" | "automatic";
}

export interface QueueRoomTranscriptionResult {
  status: "accepted" | "already_running" | "skipped";
  roomName: string;
  trigger: "manual" | "automatic";
  outputKeys: TranscriptOutputKeys;
  canonicalOutputKeys: string[];
  force: boolean;
  reason?: string;
}

interface TranscriptOutputKeys {
  trackPrefix: string;
  finalTranscript: string;
  manifest: string;
}

interface RawAppRecordingMetadata {
  roomName: string;
  participantIdentity: string;
  displayName: string;
  trackSid: string;
  audioFileKey: string | null;
  egressMetadataKey: string;
  startedAt: number | null;
  stoppedAt: number | null;
  recordedAt?: string;
}

interface RawEgressMetadataFile {
  roomName?: string;
  participantIdentity?: string;
  trackSid?: string;
  audioFile?: string;
  startedAt?: number;
  stoppedAt?: number;
  durationMs?: number;
  files?: Array<{ filename?: string }>;
}

interface CanonicalSegmentMetadata {
  track_id: string;
  source_audio_file: string;
  raw_metadata_file?: string;
  app_metadata_file?: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number;
  canonical_start_ms: number;
  canonical_end_ms: number;
}

interface CanonicalParticipantMetadata {
  room_name: string;
  participant_identity: string;
  display_name: string;
  audio_file: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number;
  updated_at: string;
  segments: CanonicalSegmentMetadata[];
}

interface OpenAITranscriptionSegment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  confidence?: number;
}

interface OpenAITranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: OpenAITranscriptionSegment[];
}

interface PreparedAudioChunk {
  filename: string;
  buffer: Buffer;
  startMs: number;
}

interface SpeechWindow {
  startMs: number;
  endMs: number;
}

interface RawTrackDescriptor {
  trackSid: string;
  roomName: string;
  participantIdentity: string;
  displayName: string;
  audioFileKey: string;
  egressMetadataKey: string;
  appMetadataKey?: string;
  startedAt: number | null;
  stoppedAt: number | null;
}

interface CanonicalParticipantDescriptor {
  roomName: string;
  participantIdentity: string;
  displayName: string;
  audioFileKey: string;
  metadataKey: string;
  startedAt: number | null;
  stoppedAt: number | null;
  durationMs: number;
  segments: CanonicalSegmentMetadata[];
}

interface TrackDescriptor {
  trackId: string;
  roomName: string;
  participantIdentity: string;
  displayName: string;
  audioFileKey: string;
  metadataKey: string;
  startedAt: number | null;
  stoppedAt: number | null;
  canonicalSegments: CanonicalSegmentMetadata[];
}

interface TrackUtterance {
  speaker_identity: string;
  speaker_name: string;
  track_id: string;
  start_ms: number;
  end_ms: number;
  absolute_start_ms: number | null;
  absolute_end_ms: number | null;
  language: string;
  original_text: string;
  english_text: string;
  confidence?: number;
}

interface TrackTranscriptArtifact {
  room_name: string;
  track_id: string;
  speaker_identity: string;
  speaker_name: string;
  started_at: number | null;
  stopped_at: number | null;
  audio_file: string;
  metadata_file: string;
  transcription_model: string;
  translation_model: string;
  language: string;
  utterances: TrackUtterance[];
}

interface MeetingTranscriptArtifact {
  room_name: string;
  generated_at: string;
  models: { transcription: string; translation: string };
  source_files: string[];
  speakers: Array<{ identity: string; display_name: string; track_id: string }>;
  utterances: Array<{
    speaker_identity: string;
    speaker_name: string;
    track_id: string;
    start_ms: number;
    end_ms: number;
    language: string;
    original_text: string;
    english_text: string;
    confidence?: number;
  }>;
  full_english_transcript: string;
  language_summary: Record<string, number>;
}

interface TranscriptionManifest {
  room_name: string;
  trigger: "manual" | "automatic";
  status: "completed" | "completed_with_errors" | "failed";
  generated_at: string;
  output_keys: TranscriptOutputKeys;
  canonical_output_keys: string[];
  source_files: string[];
  processed_tracks: number;
  failed_tracks: number;
  errors: string[];
}

interface TranscriptionRunResult {
  roomName: string;
  trigger: "manual" | "automatic";
  outputKeys: TranscriptOutputKeys;
  canonicalOutputKeys: string[];
  status: "completed" | "completed_with_errors" | "failed";
  processedTracks: number;
  failedTracks: number;
  sourceFiles: string[];
  errors: string[];
}

interface TranslationItem {
  language: string;
  english_text: string;
}

export interface RoomTranscriptionCostEstimate {
  room_name: string;
  prefix: string;
  models: { transcription: string; translation: string };
  pricing: {
    transcription_usd_per_minute: number;
    translation_input_usd_per_1m_tokens: number;
    translation_output_usd_per_1m_tokens: number;
  };
  totals: {
    tracks: number;
    total_audio_minutes: number;
    estimated_transcription_cost_usd: number;
    estimated_translation_cost_usd: number;
    estimated_total_cost_usd: number;
  };
  tracks: Array<{
    track_id: string;
    speaker_identity: string;
    speaker_name: string;
    duration_ms: number | null;
    estimated_transcription_cost_usd: number | null;
  }>;
  warnings: string[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function getOpenAIHeaders() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return { Authorization: `Bearer ${apiKey}` };
}

function getRoomPrefix(roomName: string, prefix?: string) {
  return prefix || `recordings/${roomName}/`;
}

function getOutputKeys(roomName: string, prefix?: string): TranscriptOutputKeys {
  const roomPrefix = getRoomPrefix(roomName, prefix).replace(/\/?$/, "/");
  const transcriptPrefix = `${roomPrefix}${TRANSCRIPT_DIR}/`;
  return {
    trackPrefix: transcriptPrefix,
    finalTranscript: `${transcriptPrefix}meeting_transcript.en.json`,
    manifest: `${transcriptPrefix}manifest.json`,
  };
}

function getCanonicalAudioKey(roomName: string, participantIdentity: string) {
  return `recordings/${roomName}/${participantIdentity}/${CANONICAL_AUDIO_NAME}`;
}

function getCanonicalMetadataKey(roomName: string, participantIdentity: string) {
  return `recordings/${roomName}/${participantIdentity}/${CANONICAL_METADATA_NAME}`;
}

async function objectExists(s3: S3Client, key: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function listAllKeys(s3: S3Client, prefix: string) {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET!,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const item of response.Contents || []) {
      if (item.Key) keys.push(item.Key);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function readJsonObject<T>(s3: S3Client, key: string): Promise<T> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key })
  );
  const body = await response.Body?.transformToString();
  if (!body) throw new Error(`Empty S3 object for ${key}`);
  return JSON.parse(body) as T;
}

async function readBinaryObject(s3: S3Client, key: string) {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key })
  );
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) throw new Error(`Empty binary S3 object for ${key}`);
  return Buffer.from(bytes);
}

async function writeBinaryToS3(key: string, body: Buffer, contentType: string) {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

async function writeJsonToS3(key: string, data: unknown) {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
}

function normalizeEpochMs(value: number | undefined | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 1e15) return Math.round(value / 1e6);
  if (value > 1e12) return Math.round(value);
  if (value > 1e9) return Math.round(value * 1000);
  return Math.round(value);
}

function extractTrackSid(key: string) {
  const match = key.match(/(?:APP_|EG_|TR_)(TR_[A-Za-z0-9]+)/);
  return match?.[1] || null;
}

function resolveRawAudioKey(
  egress: RawEgressMetadataFile | null,
  appMetadata: RawAppRecordingMetadata | null
) {
  if (appMetadata?.audioFileKey) return appMetadata.audioFileKey;
  if (egress?.audioFile && egress.roomName && egress.participantIdentity) {
    return `recordings/${egress.roomName}/${egress.participantIdentity}/${egress.audioFile}`;
  }
  if (egress?.files?.[0]?.filename) {
    return egress.files[0].filename;
  }
  return null;
}

function toConfidence(segment: OpenAITranscriptionSegment) {
  if (typeof segment.confidence === "number") return segment.confidence;
  if (typeof segment.avg_logprob === "number") {
    return Number(Math.exp(segment.avg_logprob).toFixed(4));
  }
  return undefined;
}

async function discoverRawTracks(roomName: string, prefix?: string): Promise<RawTrackDescriptor[]> {
  const s3 = getS3Client();
  const roomPrefix = getRoomPrefix(roomName, prefix);
  const keys = await listAllKeys(s3, roomPrefix);
  const metadataKeys = keys.filter(
    (key) =>
      key.endsWith(".json") &&
      !key.includes(`/${TRANSCRIPT_DIR}/`) &&
      !key.endsWith(`/${CANONICAL_METADATA_NAME}`) &&
      (key.includes("/EG_") || key.includes(`/${APP_METADATA_PREFIX}`))
  );

  const byTrack = new Map<string, { egressKey?: string; appKey?: string }>();

  for (const key of metadataKeys) {
    const trackSid = extractTrackSid(key);
    if (!trackSid) continue;
    const entry = byTrack.get(trackSid) || {};
    if (key.includes(`/${APP_METADATA_PREFIX}`)) entry.appKey = key;
    else if (key.includes("/EG_")) entry.egressKey = key;
    byTrack.set(trackSid, entry);
  }

  const tracks: RawTrackDescriptor[] = [];

  for (const [trackSid, entry] of Array.from(byTrack.entries())) {
    try {
      const [egress, appMetadata] = await Promise.all([
        entry.egressKey
          ? readJsonObject<RawEgressMetadataFile>(s3, entry.egressKey)
          : Promise.resolve(null),
        entry.appKey
          ? readJsonObject<RawAppRecordingMetadata>(s3, entry.appKey)
          : Promise.resolve(null),
      ]);

      const audioFileKey = resolveRawAudioKey(egress, appMetadata);
      if (!audioFileKey) throw new Error(`No audio file found for ${trackSid}`);

      const discoveredRoomName = egress?.roomName || appMetadata?.roomName;
      if (discoveredRoomName && discoveredRoomName !== roomName) continue;

      tracks.push({
        trackSid,
        roomName,
        participantIdentity:
          appMetadata?.participantIdentity || egress?.participantIdentity || "unknown",
        displayName:
          appMetadata?.displayName || egress?.participantIdentity || "Unknown speaker",
        audioFileKey,
        egressMetadataKey: entry.egressKey || "",
        appMetadataKey: entry.appKey,
        startedAt:
          normalizeEpochMs(appMetadata?.startedAt) ||
          normalizeEpochMs(egress?.startedAt),
        stoppedAt:
          normalizeEpochMs(appMetadata?.stoppedAt) ||
          normalizeEpochMs(egress?.stoppedAt),
      });
    } catch (error) {
      console.error(`Failed to load raw metadata for ${trackSid}:`, error);
    }
  }

  return tracks.sort((a, b) => {
    const aStart = a.startedAt ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.startedAt ?? Number.MAX_SAFE_INTEGER;
    return aStart - bStart;
  });
}

function sortSegments(rawTracks: RawTrackDescriptor[]) {
  return [...rawTracks].sort((a, b) => {
    const aStart = a.startedAt ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.startedAt ?? Number.MAX_SAFE_INTEGER;
    if (aStart !== bStart) return aStart - bStart;
    return a.trackSid.localeCompare(b.trackSid);
  });
}

function toCanonicalMetadata(
  roomName: string,
  participantIdentity: string,
  displayName: string,
  segments: CanonicalSegmentMetadata[]
): CanonicalParticipantMetadata {
  const startedAtCandidates = segments
    .map((segment) => segment.started_at)
    .filter((value): value is number => typeof value === "number");
  const endedAtCandidates = segments
    .map((segment) => segment.ended_at)
    .filter((value): value is number => typeof value === "number");

  return {
    room_name: roomName,
    participant_identity: participantIdentity,
    display_name: displayName,
    audio_file: getCanonicalAudioKey(roomName, participantIdentity),
    started_at: startedAtCandidates.length > 0 ? Math.min(...startedAtCandidates) : null,
    ended_at: endedAtCandidates.length > 0 ? Math.max(...endedAtCandidates) : null,
    duration_ms: segments.reduce((sum, segment) => sum + segment.duration_ms, 0),
    updated_at: new Date().toISOString(),
    segments,
  };
}

function buildCanonicalSegments(rawTracks: RawTrackDescriptor[]) {
  let cursorMs = 0;
  return sortSegments(rawTracks).map((track) => {
    const durationMs =
      typeof track.startedAt === "number" && typeof track.stoppedAt === "number"
        ? Math.max(0, track.stoppedAt - track.startedAt)
        : 0;

    const segment: CanonicalSegmentMetadata = {
      track_id: track.trackSid,
      source_audio_file: track.audioFileKey,
      raw_metadata_file: track.egressMetadataKey || undefined,
      app_metadata_file: track.appMetadataKey,
      started_at: track.startedAt,
      ended_at: track.stoppedAt,
      duration_ms: durationMs,
      canonical_start_ms: cursorMs,
      canonical_end_ms: cursorMs + durationMs,
    };

    cursorMs += durationMs;
    return segment;
  });
}

function canonicalMatchesExisting(
  existing: CanonicalParticipantMetadata,
  next: CanonicalParticipantMetadata
) {
  if (existing.display_name !== next.display_name) return false;
  if (existing.segments.length !== next.segments.length) return false;

  return existing.segments.every((segment, index) => {
    const nextSegment = next.segments[index];
    return (
      segment.track_id === nextSegment.track_id &&
      segment.source_audio_file === nextSegment.source_audio_file &&
      segment.started_at === nextSegment.started_at &&
      segment.ended_at === nextSegment.ended_at &&
      segment.duration_ms === nextSegment.duration_ms
    );
  });
}

async function mergeParticipantAudio(rawTracks: RawTrackDescriptor[]) {
  const tempDir = await mkdtemp(join(tmpdir(), "livekit-canonical-"));
  try {
    const s3 = getS3Client();
    const inputPaths: string[] = [];

    for (let index = 0; index < rawTracks.length; index += 1) {
      const rawTrack = rawTracks[index];
      const buffer = await readBinaryObject(s3, rawTrack.audioFileKey);
      const filePath = join(tempDir, `segment-${index}.ogg`);
      await writeFile(filePath, buffer);
      inputPaths.push(filePath);
    }

    const outputPath = join(tempDir, "merged.ogg");

    if (inputPaths.length === 1) {
      return await readFile(inputPaths[0]);
    }

    const concatListPath = join(tempDir, "concat.txt");
    const concatBody = inputPaths
      .map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(concatListPath, concatBody);

    await execFileAsync("/opt/homebrew/bin/ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function canonicalizeRoomParticipants(
  roomName: string,
  prefix?: string,
  force = false
) {
  const rawTracks = await discoverRawTracks(roomName, prefix);
  const canonicalOutputKeys: string[] = [];

  if (rawTracks.length === 0) {
    return { participants: [] as CanonicalParticipantDescriptor[], canonicalOutputKeys };
  }

  const grouped = new Map<string, RawTrackDescriptor[]>();
  for (const rawTrack of rawTracks) {
    const list = grouped.get(rawTrack.participantIdentity) || [];
    list.push(rawTrack);
    grouped.set(rawTrack.participantIdentity, list);
  }

  const s3 = getS3Client();
  const participants: CanonicalParticipantDescriptor[] = [];

  for (const [participantIdentity, participantTracks] of Array.from(grouped.entries())) {
    const sortedTracks = sortSegments(participantTracks);
    const latestNamedTrack = [...sortedTracks]
      .reverse()
      .find((track) => track.displayName.trim());
    const displayName = latestNamedTrack?.displayName || participantIdentity;
    const metadataKey = getCanonicalMetadataKey(roomName, participantIdentity);
    const audioKey = getCanonicalAudioKey(roomName, participantIdentity);
    const segments = buildCanonicalSegments(sortedTracks);
    const metadata = toCanonicalMetadata(roomName, participantIdentity, displayName, segments);

    let shouldRebuild = force;
    if (!shouldRebuild) {
      try {
        const existing = await readJsonObject<CanonicalParticipantMetadata>(s3, metadataKey);
        shouldRebuild = !canonicalMatchesExisting(existing, metadata);
      } catch {
        shouldRebuild = true;
      }
    }

    if (shouldRebuild) {
      const mergedAudio = await mergeParticipantAudio(sortedTracks);
      await writeBinaryToS3(audioKey, Buffer.from(mergedAudio), "audio/ogg");
      await writeJsonToS3(metadataKey, metadata);
    }

    canonicalOutputKeys.push(audioKey, metadataKey);
    participants.push({
      roomName,
      participantIdentity,
      displayName,
      audioFileKey: audioKey,
      metadataKey,
      startedAt: metadata.started_at,
      stoppedAt: metadata.ended_at,
      durationMs: metadata.duration_ms,
      segments: metadata.segments,
    });
  }

  return { participants, canonicalOutputKeys };
}

async function discoverCanonicalParticipants(
  roomName: string,
  prefix?: string
): Promise<CanonicalParticipantDescriptor[]> {
  const s3 = getS3Client();
  const roomPrefix = getRoomPrefix(roomName, prefix);
  const keys = await listAllKeys(s3, roomPrefix);
  const metadataKeys = keys.filter(
    (key) =>
      key.endsWith(`/${CANONICAL_METADATA_NAME}`) &&
      !key.includes(`/${TRANSCRIPT_DIR}/`)
  );

  const participants: CanonicalParticipantDescriptor[] = [];

  for (const key of metadataKeys) {
    try {
      const metadata = await readJsonObject<CanonicalParticipantMetadata>(s3, key);
      participants.push({
        roomName,
        participantIdentity: metadata.participant_identity,
        displayName: metadata.display_name,
        audioFileKey: metadata.audio_file,
        metadataKey: key,
        startedAt: metadata.started_at,
        stoppedAt: metadata.ended_at,
        durationMs: metadata.duration_ms,
        segments: metadata.segments || [],
      });
    } catch (error) {
      console.error(`Failed to read canonical metadata ${key}:`, error);
    }
  }

  return participants.sort((a, b) => {
    const aStart = a.startedAt ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.startedAt ?? Number.MAX_SAFE_INTEGER;
    return aStart - bStart;
  });
}

function toTrackDescriptors(participants: CanonicalParticipantDescriptor[]): TrackDescriptor[] {
  return participants.map((participant) => ({
    trackId: participant.participantIdentity,
    roomName: participant.roomName,
    participantIdentity: participant.participantIdentity,
    displayName: participant.displayName,
    audioFileKey: participant.audioFileKey,
    metadataKey: participant.metadataKey,
    startedAt: participant.startedAt,
    stoppedAt: participant.stoppedAt,
    canonicalSegments: participant.segments,
  }));
}

function mapCanonicalMsToAbsolute(
  segments: CanonicalSegmentMetadata[],
  canonicalMs: number
) {
  if (segments.length === 0) return null;

  const exactSegment = segments.find((segment) => {
    if (segment.duration_ms === 0) return canonicalMs === segment.canonical_start_ms;
    return canonicalMs >= segment.canonical_start_ms && canonicalMs <= segment.canonical_end_ms;
  });

  const segment = exactSegment || segments[segments.length - 1];
  if (typeof segment.started_at !== "number") return null;

  const offsetMs = Math.max(0, canonicalMs - segment.canonical_start_ms);
  return segment.started_at + Math.min(offsetMs, segment.duration_ms);
}

function parseTimestampToMs(value: string) {
  const match = value.match(/(\d+):(\d+):([\d.]+)/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;

  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function normalizeSpeechWindows(
  windows: SpeechWindow[],
  totalDurationMs: number
): SpeechWindow[] {
  if (windows.length === 0) return [];

  const padded = windows
    .map((window) => ({
      startMs: Math.max(0, window.startMs - VAD_PADDING_MS),
      endMs: Math.min(totalDurationMs, window.endMs + VAD_PADDING_MS),
    }))
    .filter((window) => window.endMs - window.startMs >= VAD_MIN_SPEECH_MS)
    .sort((a, b) => a.startMs - b.startMs);

  if (padded.length === 0) return [];

  const merged: SpeechWindow[] = [padded[0]];
  for (const window of padded.slice(1)) {
    const previous = merged[merged.length - 1];
    if (window.startMs - previous.endMs <= VAD_MERGE_GAP_MS) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
      continue;
    }

    merged.push({ ...window });
  }

  return merged;
}

function extractSpeechWindowsFromSilenceLog(output: string): SpeechWindow[] {
  const durationMatch = output.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  const totalDurationMs = durationMatch
    ? parseTimestampToMs(durationMatch[1]) || 0
    : 0;

  const silenceStarts = Array.from(
    output.matchAll(/silence_start:\s*([\d.]+)/g),
    (match) => Math.round(Number(match[1]) * 1000)
  ).filter(Number.isFinite);
  const silenceEnds = Array.from(
    output.matchAll(/silence_end:\s*([\d.]+)/g),
    (match) => Math.round(Number(match[1]) * 1000)
  ).filter(Number.isFinite);

  if (totalDurationMs <= 0) return [];
  if (silenceStarts.length === 0 && silenceEnds.length === 0) {
    return [{ startMs: 0, endMs: totalDurationMs }];
  }

  const windows: SpeechWindow[] = [];
  let cursorMs = 0;

  for (let index = 0; index < silenceStarts.length; index += 1) {
    const silenceStartMs = Math.max(cursorMs, silenceStarts[index]);
    const silenceEndMs = Math.max(silenceStartMs, silenceEnds[index] ?? silenceStartMs);

    if (silenceStartMs - cursorMs >= VAD_MIN_SPEECH_MS) {
      windows.push({ startMs: cursorMs, endMs: silenceStartMs });
    }

    cursorMs = silenceEndMs;
  }

  if (totalDurationMs - cursorMs >= VAD_MIN_SPEECH_MS) {
    windows.push({ startMs: cursorMs, endMs: totalDurationMs });
  }

  return normalizeSpeechWindows(windows, totalDurationMs);
}

async function normalizeAudioFile(inputPath: string, normalizedPath: string) {
  await execFileAsync(
    "/opt/homebrew/bin/ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      "highpass=f=120,lowpass=f=7600,dynaudnorm",
      normalizedPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );
}

async function detectSpeechWindows(normalizedPath: string) {
  const { stderr } = await execFileAsync(
    "/opt/homebrew/bin/ffmpeg",
    [
      "-i",
      normalizedPath,
      "-af",
      `silencedetect=noise=${VAD_SILENCE_NOISE}:d=${VAD_MIN_SILENCE_SECONDS}`,
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const durationMatch = stderr.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  return {
    totalDurationMs: durationMatch ? parseTimestampToMs(durationMatch[1]) || 0 : 0,
    speechWindows: extractSpeechWindowsFromSilenceLog(stderr),
  };
}

async function prepareAudioChunks(
  audioBuffer: Buffer,
  baseName: string
): Promise<PreparedAudioChunk[]> {
  const tempDir = await mkdtemp(join(tmpdir(), "livekit-whisper-"));
  try {
    const inputPath = join(tempDir, "input.ogg");
    const normalizedPath = join(tempDir, "normalized.wav");
    await writeFile(inputPath, audioBuffer);
    await normalizeAudioFile(inputPath, normalizedPath);

    const { speechWindows, totalDurationMs } = await detectSpeechWindows(normalizedPath);
    const windows =
      speechWindows.length > 0
        ? speechWindows
        : [{ startMs: 0, endMs: Math.max(totalDurationMs, 1000) }];

    const chunks: PreparedAudioChunk[] = [];
    let chunkIndex = 0;

    for (const window of windows) {
      for (
        let chunkStartMs = window.startMs;
        chunkStartMs < window.endMs;
        chunkStartMs += WHISPER_CHUNK_SECONDS * 1000
      ) {
        const chunkEndMs = Math.min(
          window.endMs,
          chunkStartMs + WHISPER_CHUNK_SECONDS * 1000
        );
        const durationMs = chunkEndMs - chunkStartMs;
        if (durationMs < VAD_MIN_SPEECH_MS) continue;

        const chunkPath = join(tempDir, `chunk-${String(chunkIndex).padStart(3, "0")}.wav`);
        await execFileAsync(
          "/opt/homebrew/bin/ffmpeg",
          [
            "-y",
            "-ss",
            (chunkStartMs / 1000).toFixed(3),
            "-t",
            (durationMs / 1000).toFixed(3),
            "-i",
            normalizedPath,
            "-acodec",
            "pcm_s16le",
            chunkPath,
          ],
          { maxBuffer: 10 * 1024 * 1024 }
        );

        chunks.push({
          filename: `${baseName}-chunk-${String(chunkIndex).padStart(3, "0")}.wav`,
          buffer: await readFile(chunkPath),
          startMs: chunkStartMs,
        });

        chunkIndex += 1;
      }
    }

    if (chunks.length === 0) {
      chunks.push({
        filename: `${baseName}-normalized.wav`,
        buffer: await readFile(normalizedPath),
        startMs: 0,
      });
    }

    return chunks;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildTranscriptionPrompt(track: TrackDescriptor) {
  if (!TRANSCRIPTION_HINTS.trim()) {
    return "";
  }

  return `Vocabulary hints: ${TRANSCRIPTION_HINTS.trim()}`;
}

function inferMeetingLanguageLabel(originalText: string, englishText?: string) {
  const source = originalText.toLowerCase();
  const translated = (englishText || "").toLowerCase();

  const devanagari = /[\u0900-\u097f]/.test(originalText);
  const hindiHints = [
    "hai",
    "haan",
    "nahi",
    "nahiin",
    "kya",
    "kaise",
    "mera",
    "meri",
    "kar",
    "kr",
    "acha",
    "achha",
    "theek",
    "thik",
    "yaar",
    "bhai",
    "matlab",
    "aur",
    "haanji",
  ];
  const englishHints = [
    "the",
    "and",
    "this",
    "that",
    "what",
    "testing",
    "meeting",
    "transcription",
    "thank",
    "please",
    "work",
    "phase",
  ];

  const hindiScore = hindiHints.reduce(
    (count, word) => count + (source.includes(word) ? 1 : 0),
    devanagari ? 2 : 0
  );
  const englishScore = englishHints.reduce(
    (count, word) =>
      count + (source.includes(word) || translated.includes(word) ? 1 : 0),
    0
  );

  if (hindiScore > 0 && englishScore > 0) return "mixed";
  if (hindiScore > 0) return "hi";
  if (englishScore > 0) return "en";
  return "unknown";
}

async function transcribeAudio(buffer: Buffer, filename: string, prompt: string) {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: "audio/ogg" });
  form.append("file", blob, filename);
  form.append("model", DEFAULT_TRANSCRIPTION_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (prompt.trim()) {
    form.append("prompt", prompt);
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

  return (await response.json()) as OpenAITranscriptionResponse;
}

async function translateBatch(items: Array<{ index: number; text: string; language: string }>) {
  if (items.length === 0) return new Map<number, TranslationItem>();

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { ...getOpenAIHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_TRANSLATION_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Translate meeting utterances to English. Return JSON with top-level 'items' array. Each item: { index, language, english_text }. Use only these language labels: 'en', 'hi', 'mixed', or 'unknown'. Prefer 'mixed' for code-switched Hindi-English meeting speech.",
        },
        { role: "user", content: JSON.stringify({ items }) },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI translation failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Translation response was empty");

  const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "")) as {
    items?: Array<{ index: number; language: string; english_text: string }>;
  };

  const result = new Map<number, TranslationItem>();
  for (const item of parsed.items || []) {
    if (typeof item.index === "number") {
      result.set(item.index, {
        language: item.language || "unknown",
        english_text: item.english_text || "",
      });
    }
  }
  return result;
}

async function translateUtterances(
  utterances: Array<{ original_text: string; language: string }>
) {
  const translations = new Map<number, TranslationItem>();
  const chunkSize = 50;

  for (let start = 0; start < utterances.length; start += chunkSize) {
    const chunk = utterances.slice(start, start + chunkSize);
    const chunkResult = await translateBatch(
      chunk.map((utterance, index) => ({
        index: start + index,
        text: utterance.original_text,
        language: utterance.language,
      }))
    );

    for (const [index, item] of Array.from(chunkResult.entries())) {
      translations.set(index, item);
    }
  }

  return translations;
}

function splitFallbackUtterances(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildTrackUtterances(track: TrackDescriptor, transcription: OpenAITranscriptionResponse) {
  const language = transcription.language || "unknown";
  const segments =
    transcription.segments?.filter(
      (segment) =>
        segment.text &&
        typeof segment.start === "number" &&
        typeof segment.end === "number"
    ) || [];

  if (segments.length === 0 && transcription.text) {
    return splitFallbackUtterances(transcription.text).map((text, index) => {
      const startMs = index * 1000;
      const endMs = (index + 1) * 1000;
      return {
        speaker_identity: track.participantIdentity,
        speaker_name: track.displayName,
        track_id: track.trackId,
        start_ms: startMs,
        end_ms: endMs,
        absolute_start_ms: mapCanonicalMsToAbsolute(track.canonicalSegments, startMs),
        absolute_end_ms: mapCanonicalMsToAbsolute(track.canonicalSegments, endMs),
        language,
        original_text: text,
        english_text: "",
      };
    });
  }

  return segments.map((segment) => {
    const startMs = Math.max(0, Math.round((segment.start || 0) * 1000));
    const endMs = Math.max(startMs, Math.round((segment.end || 0) * 1000));
    return {
      speaker_identity: track.participantIdentity,
      speaker_name: track.displayName,
      track_id: track.trackId,
      start_ms: startMs,
      end_ms: endMs,
      absolute_start_ms: mapCanonicalMsToAbsolute(track.canonicalSegments, startMs),
      absolute_end_ms: mapCanonicalMsToAbsolute(track.canonicalSegments, endMs),
      language,
      original_text: segment.text?.trim() || "",
      english_text: "",
      confidence: toConfidence(segment),
    };
  });
}

function mergeAdjacentUtterances(utterances: TrackUtterance[]) {
  if (utterances.length <= 1) return utterances;

  const merged: TrackUtterance[] = [];

  for (const utterance of utterances) {
    const previous = merged[merged.length - 1];
    const shouldMerge =
      previous &&
      previous.speaker_identity === utterance.speaker_identity &&
      previous.language === utterance.language &&
      utterance.start_ms - previous.end_ms <= 1200 &&
      previous.original_text.length + utterance.original_text.length < 400;

    if (!shouldMerge) {
      merged.push({ ...utterance });
      continue;
    }

    previous.end_ms = utterance.end_ms;
    previous.absolute_end_ms = utterance.absolute_end_ms;
    previous.original_text = `${previous.original_text} ${utterance.original_text}`.trim();
    previous.english_text = `${previous.english_text} ${utterance.english_text}`.trim();

    if (
      typeof previous.confidence === "number" &&
      typeof utterance.confidence === "number"
    ) {
      previous.confidence = Number(
        ((previous.confidence + utterance.confidence) / 2).toFixed(4)
      );
    } else if (typeof previous.confidence !== "number") {
      previous.confidence = utterance.confidence;
    }
  }

  return merged;
}

function normalizeNoiseText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\u0900-\u097f\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRepeatedTokenPhrase(normalizedText: string) {
  const tokens = normalizedText.split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((token) => token === tokens[0]);
}

function isLikelyNoiseUtterance(utterance: TrackUtterance) {
  const confidence =
    typeof utterance.confidence === "number" ? utterance.confidence : 1;
  if (confidence >= NOISE_MIN_CONFIDENCE) return false;

  const normalizedText = normalizeNoiseText(utterance.original_text);
  const durationMs = Math.max(0, utterance.end_ms - utterance.start_ms);
  const shortText = normalizedText.length > 0 && normalizedText.length <= NOISE_MAX_CHARS;
  const shortDuration = durationMs <= NOISE_MAX_DURATION_MS;

  const fillerTerms = new Set([
    "you",
    "bye",
    "yeah",
    "okay",
    "ok",
    "shh",
    "hmm",
    "um",
    "uh",
    "hello",
    "hi",
    "peace",
  ]);

  const tokens = normalizedText.split(" ").filter(Boolean);
  const onlyFiller =
    tokens.length > 0 && tokens.every((token) => fillerTerms.has(token));

  if (!shortDuration) return false;
  if (onlyFiller) return true;
  if (shortText && isRepeatedTokenPhrase(normalizedText)) return true;
  if (shortText && tokens.length <= 2) return true;
  return false;
}

function filterNoiseUtterances(utterances: TrackUtterance[]) {
  return utterances.filter((utterance) => !isLikelyNoiseUtterance(utterance));
}

async function createTrackTranscript(track: TrackDescriptor): Promise<TrackTranscriptArtifact> {
  const s3 = getS3Client();
  const audioBuffer = await readBinaryObject(s3, track.audioFileKey);
  const preparedChunks = await prepareAudioChunks(audioBuffer, track.trackId);
  const prompt = buildTranscriptionPrompt(track);
  const chunkUtterances: TrackUtterance[] = [];
  let dominantLanguage = "unknown";

  for (const chunk of preparedChunks) {
    const transcription = await transcribeAudio(chunk.buffer, chunk.filename, prompt);
    if (dominantLanguage === "unknown" && transcription.language) {
      dominantLanguage = transcription.language;
    }

    const utterancesForChunk = buildTrackUtterances(track, transcription)
      .filter((item) => item.original_text)
      .map((item) => ({
        ...item,
        start_ms: item.start_ms + chunk.startMs,
        end_ms: item.end_ms + chunk.startMs,
        absolute_start_ms: mapCanonicalMsToAbsolute(
          track.canonicalSegments,
          item.start_ms + chunk.startMs
        ),
        absolute_end_ms: mapCanonicalMsToAbsolute(
          track.canonicalSegments,
          item.end_ms + chunk.startMs
        ),
      }));

    chunkUtterances.push(...utterancesForChunk);
  }

  const utterances = filterNoiseUtterances(
    mergeAdjacentUtterances(chunkUtterances)
  );
  const translations = await translateUtterances(
    utterances.map((utterance) => ({
      original_text: utterance.original_text,
      language: utterance.language,
    }))
  );

  const hydratedUtterances = filterNoiseUtterances(
    utterances.map((utterance, index) => {
      const translation = translations.get(index);
      const englishText = translation?.english_text || utterance.original_text;
      const inferredLanguage =
        translation?.language && ["en", "hi", "mixed", "unknown"].includes(translation.language)
          ? translation.language
          : inferMeetingLanguageLabel(utterance.original_text, englishText);

      return {
        ...utterance,
        language: inferredLanguage === "unknown"
          ? inferMeetingLanguageLabel(utterance.original_text, englishText)
          : inferredLanguage,
        english_text: englishText,
      };
    })
  );

  return {
    room_name: track.roomName,
    track_id: track.trackId,
    speaker_identity: track.participantIdentity,
    speaker_name: track.displayName,
    started_at: track.startedAt,
    stopped_at: track.stoppedAt,
    audio_file: track.audioFileKey,
    metadata_file: track.metadataKey,
    transcription_model: DEFAULT_TRANSCRIPTION_MODEL,
    translation_model: DEFAULT_TRANSLATION_MODEL,
    language: dominantLanguage,
    utterances: hydratedUtterances,
  };
}

function buildMeetingTranscript(
  roomName: string,
  trackArtifacts: TrackTranscriptArtifact[],
  sourceFiles: string[]
): MeetingTranscriptArtifact {
  const roomStartCandidates = trackArtifacts
    .map((artifact) => artifact.started_at)
    .filter((value): value is number => typeof value === "number");
  const roomStartMs =
    roomStartCandidates.length > 0 ? Math.min(...roomStartCandidates) : 0;

  const utterances = trackArtifacts
    .flatMap((artifact) =>
      artifact.utterances.map((utterance) => {
        const relativeStart =
          typeof utterance.absolute_start_ms === "number"
            ? Math.max(0, utterance.absolute_start_ms - roomStartMs)
            : utterance.start_ms;
        const relativeEnd =
          typeof utterance.absolute_end_ms === "number"
            ? Math.max(relativeStart, utterance.absolute_end_ms - roomStartMs)
            : utterance.end_ms;

        return {
          ...utterance,
          start_ms: relativeStart,
          end_ms: relativeEnd,
          _absolute_sort: utterance.absolute_start_ms ?? utterance.start_ms,
        };
      })
    )
    .sort((left, right) => left._absolute_sort - right._absolute_sort)
    .map(({ _absolute_sort, absolute_start_ms, absolute_end_ms, ...utterance }) => utterance);

  const languageSummary: Record<string, number> = {};
  for (const utterance of utterances) {
    languageSummary[utterance.language] = (languageSummary[utterance.language] || 0) + 1;
  }

  return {
    room_name: roomName,
    generated_at: new Date().toISOString(),
    models: {
      transcription: DEFAULT_TRANSCRIPTION_MODEL,
      translation: DEFAULT_TRANSLATION_MODEL,
    },
    source_files: sourceFiles,
    speakers: trackArtifacts.map((artifact) => ({
      identity: artifact.speaker_identity,
      display_name: artifact.speaker_name,
      track_id: artifact.track_id,
    })),
    utterances,
    full_english_transcript: utterances
      .map((utterance) => `${utterance.speaker_name}: ${utterance.english_text}`)
      .join("\n"),
    language_summary: languageSummary,
  };
}

async function runRoomTranscriptionJob(
  options: QueueRoomTranscriptionOptions
): Promise<TranscriptionRunResult> {
  const { roomName, prefix, trigger, force = false } = options;
  const outputKeys = getOutputKeys(roomName, prefix);
  const s3 = getS3Client();

  if (trigger === "automatic") await sleep(3000);

  const canonicalized = await canonicalizeRoomParticipants(roomName, prefix, force);
  const canonicalParticipants =
    canonicalized.participants.length > 0
      ? canonicalized.participants
      : await discoverCanonicalParticipants(roomName, prefix);

  if (!force && (await objectExists(s3, outputKeys.finalTranscript))) {
    return {
      roomName,
      trigger,
      outputKeys,
      canonicalOutputKeys: canonicalized.canonicalOutputKeys,
      status: "completed",
      processedTracks: 0,
      failedTracks: 0,
      sourceFiles: canonicalParticipants.map((participant) => participant.audioFileKey),
      errors: [],
    };
  }

  if (canonicalParticipants.length === 0) {
    const error = `No canonical participant files found under ${getRoomPrefix(roomName, prefix)}`;
    await writeJsonToS3(outputKeys.manifest, {
      room_name: roomName,
      trigger,
      status: "failed",
      generated_at: new Date().toISOString(),
      output_keys: outputKeys,
      canonical_output_keys: canonicalized.canonicalOutputKeys,
      source_files: [],
      processed_tracks: 0,
      failed_tracks: 0,
      errors: [error],
    } as TranscriptionManifest);

    return {
      roomName,
      trigger,
      outputKeys,
      canonicalOutputKeys: canonicalized.canonicalOutputKeys,
      status: "failed",
      processedTracks: 0,
      failedTracks: 0,
      sourceFiles: [],
      errors: [error],
    };
  }

  const tracks = toTrackDescriptors(canonicalParticipants);
  const trackArtifacts: TrackTranscriptArtifact[] = [];
  const errors: string[] = [];
  const sourceFiles = canonicalParticipants.map((participant) => participant.audioFileKey);

  for (const track of tracks) {
    try {
      const artifact = await createTrackTranscript(track);
      trackArtifacts.push(artifact);
      await writeJsonToS3(`${outputKeys.trackPrefix}track_${track.trackId}.json`, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`${track.trackId}: ${message}`);
    }
  }

  const status =
    errors.length === 0
      ? "completed"
      : trackArtifacts.length > 0
        ? "completed_with_errors"
        : "failed";

  if (trackArtifacts.length > 0) {
    await writeJsonToS3(
      outputKeys.finalTranscript,
      buildMeetingTranscript(roomName, trackArtifacts, sourceFiles)
    );
  }

  await writeJsonToS3(outputKeys.manifest, {
    room_name: roomName,
    trigger,
    status,
    generated_at: new Date().toISOString(),
    output_keys: outputKeys,
    canonical_output_keys: canonicalized.canonicalOutputKeys,
    source_files: sourceFiles,
    processed_tracks: trackArtifacts.length,
    failed_tracks: tracks.length - trackArtifacts.length,
    errors,
  } as TranscriptionManifest);

  return {
    roomName,
    trigger,
    outputKeys,
    canonicalOutputKeys: canonicalized.canonicalOutputKeys,
    status,
    processedTracks: trackArtifacts.length,
    failedTracks: tracks.length - trackArtifacts.length,
    sourceFiles,
    errors,
  };
}

export async function queueRoomTranscription(
  options: QueueRoomTranscriptionOptions
): Promise<QueueRoomTranscriptionResult> {
  const { roomName, prefix, force = false, trigger } = options;
  const outputKeys = getOutputKeys(roomName, prefix);
  const roomKey = `${roomName}:${prefix || ""}`;

  if (roomJobs.has(roomKey)) {
    return {
      status: "already_running",
      roomName,
      trigger,
      outputKeys,
      canonicalOutputKeys: [],
      force,
      reason: "A transcription job is already running for this room",
    };
  }

  const job = runRoomTranscriptionJob(options)
    .catch((error) => {
      console.error(`Room transcription failed for ${roomName}:`, error);
      throw error;
    })
    .finally(() => {
      roomJobs.delete(roomKey);
    });

  roomJobs.set(roomKey, job);

  return {
    status: "accepted",
    roomName,
    trigger,
    outputKeys,
    canonicalOutputKeys: [],
    force,
  };
}

export async function estimateRoomTranscriptionCost(
  roomName: string,
  prefix?: string
): Promise<RoomTranscriptionCostEstimate> {
  await canonicalizeRoomParticipants(roomName, prefix, false);
  const canonicalParticipants = await discoverCanonicalParticipants(roomName, prefix);

  const pricing = {
    transcriptionUsdPerMinute: Number(
      process.env.OPENAI_TRANSCRIPTION_USD_PER_MINUTE || "0.006"
    ),
    translationInputUsdPer1MTokens: Number(
      process.env.OPENAI_TRANSLATION_INPUT_USD_PER_1M_TOKENS || "0.15"
    ),
    translationOutputUsdPer1MTokens: Number(
      process.env.OPENAI_TRANSLATION_OUTPUT_USD_PER_1M_TOKENS || "0.6"
    ),
  };

  const estimatedTracks = canonicalParticipants.map((participant) => {
    const durationMs = participant.durationMs || null;
    const cost =
      durationMs === null
        ? null
        : Number(
            ((durationMs / 60000) * pricing.transcriptionUsdPerMinute).toFixed(6)
          );

    return {
      track_id: participant.participantIdentity,
      speaker_identity: participant.participantIdentity,
      speaker_name: participant.displayName,
      duration_ms: durationMs,
      estimated_transcription_cost_usd: cost,
    };
  });

  const totalMinutes = estimatedTracks.reduce(
    (sum, track) => sum + (track.duration_ms || 0) / 60000,
    0
  );
  const transcriptionCost = estimatedTracks.reduce(
    (sum, track) => sum + (track.estimated_transcription_cost_usd || 0),
    0
  );
  const translationCost = Number((transcriptionCost * 0.03).toFixed(6));

  return {
    room_name: roomName,
    prefix: getRoomPrefix(roomName, prefix),
    models: {
      transcription: DEFAULT_TRANSCRIPTION_MODEL,
      translation: DEFAULT_TRANSLATION_MODEL,
    },
    pricing: {
      transcription_usd_per_minute: pricing.transcriptionUsdPerMinute,
      translation_input_usd_per_1m_tokens:
        pricing.translationInputUsdPer1MTokens,
      translation_output_usd_per_1m_tokens:
        pricing.translationOutputUsdPer1MTokens,
    },
    totals: {
      tracks: estimatedTracks.length,
      total_audio_minutes: Number(totalMinutes.toFixed(2)),
      estimated_transcription_cost_usd: Number(transcriptionCost.toFixed(6)),
      estimated_translation_cost_usd: translationCost,
      estimated_total_cost_usd: Number((transcriptionCost + translationCost).toFixed(6)),
    },
    tracks: estimatedTracks,
    warnings: canonicalParticipants
      .filter((participant) => participant.durationMs === 0)
      .map((participant) => `Missing duration metadata for ${participant.participantIdentity}`),
  };
}
