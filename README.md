# LiveKit Meeting App

Self-hosted video meetings with automatic per-participant audio recording and transcription. Built with Next.js 14, LiveKit, and Docker.

---

## Stack

| Component | Role |
|-----------|------|
| Next.js 14 | Frontend + API routes |
| LiveKit (Docker) | WebRTC signaling and media server |
| LiveKit Egress (Docker) | Records each participant's audio track as `.ogg` → S3 |
| Redis (Docker) | LiveKit session/room state |
| Metered.ca TURN | Hosted TURN relay for guests behind NAT/firewall |
| AWS S3 | Stores recordings and transcripts |
| ffmpeg | Audio normalization and canonical merge |
| Silero VAD (`@ricky0123/vad-node`) | Neural voice activity detection for speech windowing |
| OpenAI Whisper or Mistral Voxtral | Audio transcription |
| GPT-4o-mini | Translation and language detection |

---

## How It Works

### Network topology

Two ngrok tunnels expose the app from your local machine:

| Tunnel | Port | Purpose |
|--------|------|---------|
| ngrok #1 | 3000 | Next.js app — share this URL with guests |
| ngrok #2 | 7880 | LiveKit signaling (WebSocket) |

Media flows through Metered.ca TURN servers — no UDP ports need to be opened locally.

### Recording flow

1. Participant joins → mic track is published
2. Backend starts a LiveKit TrackEgress for that participant → raw `.ogg` fragments upload to S3
3. On leave → egress stops, metadata files (`EG_*`, `APP_*`) are written to S3
4. Raw fragments are grouped by stable participant identity and merged into one canonical `audio.ogg` per participant
5. One canonical `metadata.json` is written per participant

### Transcription flow

1. When the **last participant** stops recording, transcription is **automatically queued** (3s delay to let S3 writes settle)
2. Canonical audio is normalized to 16kHz mono WAV via ffmpeg
3. **Silero VAD** runs on the normalized audio to detect speech windows (neural model, handles background noise and low-volume speech)
4. Speech windows are padded, merged, and chunked into ~45s segments
5. Each chunk is sent to the configured transcription provider (OpenAI Whisper or Mistral Voxtral)
6. Utterances are translated to English via GPT-4o-mini (batched, 50 at a time)
7. All per-track transcripts are merged into a single meeting transcript sorted by wall-clock time
8. Transcript and manifest are written to S3 under `_transcripts/`

If a session ends abnormally (browser crash, network drop), the last egress may not stop cleanly and auto-transcription won't fire. In that case, trigger it manually — see [Manual Transcription](#manual-transcription).

---

## S3 Storage Layout

```
<bucket>/
└── recordings/
    └── <room-name>/
        ├── <participant-identity>/
        │   ├── TR_<trackSid>.ogg       ← raw egress fragment
        │   ├── EG_<trackSid>.json      ← raw egress metadata
        │   ├── APP_<trackSid>.json     ← app metadata (display name, timestamps)
        │   ├── audio.ogg               ← canonical merged audio
        │   └── metadata.json           ← canonical participant metadata
        └── _transcripts/
            ├── meeting_transcript.en.json   ← default provider output
            ├── manifest.json
            └── providers/
                ├── openai/
                │   ├── meeting_transcript.en.json
                │   └── manifest.json
                └── voxtral/
                    ├── meeting_transcript.en.json
                    └── manifest.json
```

`TR_*`, `EG_*`, and `APP_*` are internal artifacts. The user-facing outputs are `audio.ogg`, `metadata.json`, and everything under `_transcripts/`.

The default provider (set via `TRANSCRIPTION_PROVIDER`) also writes the top-level `_transcripts/meeting_transcript.en.json`. Provider-specific outputs always go under `providers/<name>/` so OpenAI and Voxtral can be compared side by side.

---

## Setup

### Prerequisites

- Docker + Docker Compose
- Node.js 18+
- ffmpeg installed locally (`brew install ffmpeg` on macOS)
- AWS S3 bucket with an IAM user
- Two ngrok tunnels
- Metered.ca account (free tier) for TURN credentials
- OpenAI API key
- Mistral API key (if using Voxtral)

### 1. Config files

```bash
cp egress.yaml.example egress.yaml
cp livekit.yaml.example livekit.yaml
```

Fill in `egress.yaml`:
- `api_key` / `api_secret` — must match `livekit.yaml` and `.env.local`
- `s3.access_key` / `s3.secret` / `s3.region` / `s3.bucket` — your AWS credentials

Fill in `livekit.yaml`:
- `keys` — your API key/secret pair
- `turn_servers` — Metered.ca username and credential

### 2. Environment variables

Create `.env.local`:

```env
# LiveKit
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# Auth
JWT_SECRET=your_jwt_secret          # openssl rand -hex 32
APP_PASSWORD=your_app_password

# AWS S3
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_REGION=us-east-1
S3_BUCKET=your_bucket_name

# ngrok (update each time the tunnel restarts)
NEXT_PUBLIC_LIVEKIT_URL=wss://your-ngrok-7880-url

# Transcription
TRANSCRIPTION_PROVIDER=voxtral      # openai | voxtral
OPENAI_API_KEY=your_openai_key
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_TRANSLATION_MODEL=gpt-4o-mini
MISTRAL_API_KEY=your_mistral_key
MISTRAL_TRANSCRIPTION_MODEL=voxtral-mini-latest
MISTRAL_TRANSCRIPTION_DIARIZE=false

# Optional tuning
WHISPER_CHUNK_SECONDS=45
VAD_POSITIVE_SPEECH_THRESHOLD=0.5   # Silero: higher = stricter speech detection
VAD_NEGATIVE_SPEECH_THRESHOLD=0.35  # Silero: lower = more aggressive silence removal
VAD_MIN_SPEECH_MS=400
VAD_PADDING_MS=200
VAD_MERGE_GAP_MS=700
NOISE_MIN_CONFIDENCE=0.52
NOISE_MAX_DURATION_MS=2200
NOISE_MAX_CHARS=12
OPENAI_TRANSCRIPTION_HINTS=         # comma-separated vocabulary hints for Whisper
```

### 3. Start Docker stack

```bash
docker compose up -d
docker compose ps    # verify livekit-server, livekit-redis, livekit-egress are all running
```

### 4. Start ngrok (two terminals)

```bash
ngrok http 3000
ngrok http 7880
```

Update `NEXT_PUBLIC_LIVEKIT_URL` in `.env.local` with the `wss://` URL for port 7880 each time it changes, then restart the app.

### 5. Install and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) or share the ngrok 3000 URL with guests.

---

## AWS IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectAcl", "s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::your-bucket-name",
        "arn:aws:s3:::your-bucket-name/*"
      ]
    }
  ]
}
```

---

## API Routes

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/auth/login` | none | Password login, returns app JWT |
| POST | `/api/token` | JWT | Generate LiveKit room token |
| POST | `/api/egress/start` | JWT | Start per-participant track recording |
| POST | `/api/egress/stop` | JWT | Stop recording, write metadata, auto-queue transcription |
| POST | `/api/transcription/run` | JWT | Manually trigger transcription for a room |
| POST | `/api/transcription/estimate` | JWT | Estimate transcription cost for a room |

All authenticated routes accept the JWT as `Authorization: Bearer <token>` or as `appToken` in the request body.

---

## Manual Transcription

Get a JWT first (or reuse one from the browser's localStorage):

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your_app_password"}' | jq -r .token
```

Trigger transcription for a room:

```bash
curl -X POST http://localhost:3000/api/transcription/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"roomName":"meet-xxxx-yyyy","force":true}'
```

Run with a specific provider (results go to `providers/<name>/`, doesn't overwrite the default):

```bash
curl -X POST http://localhost:3000/api/transcription/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"roomName":"meet-xxxx-yyyy","force":true,"provider":"openai"}'
```

---

## Transcript Format

`meeting_transcript.en.json` contains:

```json
{
  "room_name": "meet-xxxx-yyyy",
  "generated_at": "...",
  "models": { "transcription": "voxtral-mini-latest", "translation": "gpt-4o-mini" },
  "speakers": [
    { "identity": "abc123", "display_name": "Alice", "track_id": "abc123" }
  ],
  "utterances": [
    {
      "speaker_name": "Alice",
      "speaker_identity": "abc123",
      "start_ms": 5000,
      "end_ms": 8200,
      "language": "en",
      "original_text": "Hello everyone.",
      "english_text": "Hello everyone."
    }
  ],
  "full_english_transcript": "Alice: Hello everyone.\n...",
  "language_summary": { "en": 42, "hi": 10, "mixed": 5 }
}
```

`start_ms` / `end_ms` are relative to the earliest participant's join time (wall-clock aligned across all speakers).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Guest sees black screen / disconnects | TURN not working — verify Metered credentials in `livekit.yaml` |
| Recording not appearing in S3 | Check AWS credentials in `egress.yaml` and IAM permissions |
| `Failed to start recording` | Ensure `livekit-egress` container is running (`docker compose ps`) |
| Auto-transcription didn't fire | Session ended abnormally — run transcription manually with `force: true` |
| Transcript has too much noise | Raise `VAD_POSITIVE_SPEECH_THRESHOLD` (e.g. `0.6`) and rerun with `force: true` |
| Transcript is missing speech | Lower `VAD_POSITIVE_SPEECH_THRESHOLD` (e.g. `0.4`) and rerun with `force: true` |
| Can't join room | Verify `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` match across `livekit.yaml`, `egress.yaml`, and `.env.local` |
| ngrok URL changed | Update `NEXT_PUBLIC_LIVEKIT_URL` in `.env.local` and restart `npm run dev` |
| Webpack error on binary file | Ensure `next.config.js` has `experimental.serverComponentsExternalPackages` for `onnxruntime-node` |

---

## Security Notes

- `egress.yaml`, `livekit.yaml`, and `.env.local` are gitignored — never commit them
- Use the `.example` files to share config structure without secrets
- If secrets are accidentally pushed, rotate them immediately in AWS IAM and the Metered dashboard
