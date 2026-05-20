import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MINUTES_MODEL = process.env.OPENAI_MINUTES_MODEL || "gpt-4o-mini";
const TRANSCRIPT_DIR = "_transcripts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MeetingTranscript {
  room_name: string;
  generated_at: string;
  models: { transcription: string; translation: string };
  speakers: Array<{ identity: string; display_name: string; track_id: string }>;
  utterances: Array<{
    speaker_name: string;
    start_ms: number;
    end_ms: number;
    language: string;
    original_text: string;
    english_text: string;
  }>;
  full_english_transcript: string;
  language_summary: Record<string, number>;
}

export interface MeetingMinutes {
  room_name: string;
  generated_at: string;
  model: string;
  transcript_key: string;
  participants: string[];
  duration_ms: number | null;
  summary: string;
  key_points: string[];
  action_items: string[];
}

export interface GenerateMeetingMinutesResult {
  status: "completed" | "skipped" | "failed";
  roomName: string;
  outputKey: string;
  reason?: string;
  minutes?: MeetingMinutes;
}

// ── S3 helpers ────────────────────────────────────────────────────────────────

function getS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function getTranscriptKey(roomName: string, prefix?: string) {
  const roomPrefix = prefix || `recordings/${roomName}/`;
  return `${roomPrefix.replace(/\/?$/, "/")}${TRANSCRIPT_DIR}/meeting_transcript.en.json`;
}

export function getMeetingMinutesKey(roomName: string, prefix?: string) {
  const roomPrefix = prefix || `recordings/${roomName}/`;
  return `${roomPrefix.replace(/\/?$/, "/")}${TRANSCRIPT_DIR}/meeting_minutes.json`;
}

async function readJsonFromS3<T>(s3: S3Client, key: string): Promise<T> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key })
  );
  const body = await response.Body?.transformToString();
  if (!body) throw new Error(`Empty S3 object: ${key}`);
  return JSON.parse(body) as T;
}

async function objectExists(s3: S3Client, key: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return true;
  } catch {
    return false;
  }
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

// ── OpenAI helpers ────────────────────────────────────────────────────────────

function getOpenAIHeaders() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function callGPT(systemPrompt: string, userContent: string): Promise<string> {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: getOpenAIHeaders(),
    body: JSON.stringify({
      model: MINUTES_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${error}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content?.trim() ?? "";
}

// ── Core extraction functions ─────────────────────────────────────────────────

async function extractSummary(transcript: string): Promise<string> {
  return callGPT(
    "You are a highly skilled AI trained in language comprehension and summarization. " +
    "Read the following meeting transcript and summarize it into a concise paragraph. " +
    "Retain the most important points and provide a coherent, readable summary that helps " +
    "someone understand the main discussion without reading the full transcript. " +
    "Avoid unnecessary details or tangential points.",
    transcript
  );
}

async function extractKeyPoints(transcript: string): Promise<string[]> {
  const raw = await callGPT(
    "You are a proficient AI with a specialty in distilling information into key points. " +
    "Based on the following meeting transcript, identify and list the main points discussed. " +
    "These should be the most important ideas, findings, decisions, or topics. " +
    "Return ONLY a JSON array of strings, each string being one key point. " +
    'Example: ["Point one", "Point two"]. No other text.',
    transcript
  );

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).filter(Boolean);
    }
  } catch {
    // fallback: split by newlines if GPT returned plain text
    return raw
      .split("\n")
      .map((line) => line.replace(/^[-•*\d.]+\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

async function extractActionItems(transcript: string): Promise<string[]> {
  const raw = await callGPT(
    "You are an AI expert in analyzing conversations and extracting action items. " +
    "Review the following meeting transcript and identify any tasks, assignments, or actions " +
    "that were agreed upon or mentioned as needing to be done. " +
    "These could be tasks assigned to specific individuals or general group actions. " +
    "Return ONLY a JSON array of strings, each string being one action item. " +
    'Example: ["Alice will send the report by Friday", "Team to review the proposal"]. ' +
    "If no action items are found, return an empty array []. No other text.",
    transcript
  );

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).filter(Boolean);
    }
  } catch {
    return raw
      .split("\n")
      .map((line) => line.replace(/^[-•*\d.]+\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateMeetingMinutes(
  roomName: string,
  options: { prefix?: string; force?: boolean } = {}
): Promise<GenerateMeetingMinutesResult> {
  const { prefix, force = false } = options;
  const s3 = getS3Client();
  const transcriptKey = getTranscriptKey(roomName, prefix);
  const outputKey = getMeetingMinutesKey(roomName, prefix);

  console.log(
    `[meeting-minutes:start] room=${roomName} transcript=${transcriptKey} force=${force}`
  );

  // Check transcript exists
  if (!(await objectExists(s3, transcriptKey))) {
    console.warn(`[meeting-minutes:skip] room=${roomName} reason=no_transcript`);
    return {
      status: "skipped",
      roomName,
      outputKey,
      reason: `Transcript not found: ${transcriptKey}`,
    };
  }

  // Skip if already generated and not forced
  if (!force && (await objectExists(s3, outputKey))) {
    console.log(`[meeting-minutes:skip] room=${roomName} reason=already_exists`);
    const existing = await readJsonFromS3<MeetingMinutes>(s3, outputKey);
    return { status: "skipped", roomName, outputKey, minutes: existing };
  }

  // Read transcript
  const transcript = await readJsonFromS3<MeetingTranscript>(s3, transcriptKey);
  const fullText = transcript.full_english_transcript;

  if (!fullText?.trim()) {
    return {
      status: "failed",
      roomName,
      outputKey,
      reason: "Transcript is empty",
    };
  }

  // Compute duration from utterances
  const lastUtterance = transcript.utterances[transcript.utterances.length - 1];
  const durationMs = lastUtterance ? lastUtterance.end_ms : null;

  // Run all three extractions in parallel
  console.log(`[meeting-minutes:extract] room=${roomName} model=${MINUTES_MODEL}`);
  const [summary, keyPoints, actionItems] = await Promise.all([
    extractSummary(fullText),
    extractKeyPoints(fullText),
    extractActionItems(fullText),
  ]);

  const minutes: MeetingMinutes = {
    room_name: roomName,
    generated_at: new Date().toISOString(),
    model: MINUTES_MODEL,
    transcript_key: transcriptKey,
    participants: transcript.speakers.map((s) => s.display_name),
    duration_ms: durationMs,
    summary,
    key_points: keyPoints,
    action_items: actionItems,
  };

  await writeJsonToS3(outputKey, minutes);
  console.log(
    `[meeting-minutes:done] room=${roomName} key_points=${keyPoints.length} action_items=${actionItems.length}`
  );

  return { status: "completed", roomName, outputKey, minutes };
}
