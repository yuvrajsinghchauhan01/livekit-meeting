# LiveKit Meeting App

Self-hosted video meetings with automatic per-participant audio recording, S3 storage, and OpenAI-powered transcription. Built with Next.js 14, LiveKit, and Docker.

---

## Stack

- Next.js 14 — frontend + API routes
- LiveKit (self-hosted via Docker) — WebRTC signaling and media server
- LiveKit Egress — records each participant's audio track as `.ogg` and uploads to S3
- Redis — LiveKit session/room state
- Metered.ca TURN — hosted TURN relay for guests behind NAT/firewall
- AWS S3 — stores recordings and transcripts
- OpenAI Whisper — audio transcription
- GPT-4o-mini — translation and language detection

---

## How It Works

Two ngrok tunnels expose the app from your local machine:

| Tunnel | Port | Purpose |
|--------|------|---------|
| ngrok #1 | 3000 | Next.js app — share this URL with guests |
| ngrok #2 | 7880 | LiveKit signaling (WebSocket) |

Media flows through Metered.ca TURN servers — no UDP ports need to be opened locally.

Recording flow:
1. Participant joins → mic track is published
2. Backend starts a LiveKit TrackEgress for that participant
3. On leave → egress stops, `.ogg` is finalized and uploaded to S3
4. A `.json` metadata file is written alongside each recording

Transcription flow:
1. Audio is chunked into ~45s segments and sent to OpenAI Whisper
2. Utterances are translated to English via GPT-4o-mini (batched, 50 at a time)
3. A merged meeting transcript and manifest are written to S3

S3 storage layout:
```
<bucket>/
└── recordings/
    └── <room-name>/
        ├── <participant-identity>/
        │   ├── audio.ogg          ← canonical merged audio
        │   └── metadata.json      ← canonical participant metadata
        └── _transcripts/
            ├── meeting_transcript.en.json
            └── manifest.json
```

---

## Setup

### 1. Prerequisites

- Docker + Docker Compose
- Node.js 18+
- AWS S3 bucket with an IAM user
- Two ngrok tunnels running
- Metered.ca account (free tier) for TURN credentials
- OpenAI API key

### 2. Config files

These files are gitignored. Use the `.example` files as templates:

```bash
cp egress.yaml.example egress.yaml
cp livekit.yaml.example livekit.yaml
```

Fill in `egress.yaml`:
- `api_key` / `api_secret` — must match `livekit.yaml` and `.env.local`
- `s3.access_key` / `s3.secret` — AWS IAM credentials
- `s3.region` / `s3.bucket` — your S3 bucket

Fill in `livekit.yaml`:
- `keys` — your API key/secret pair
- `turn_servers` — Metered.ca username and credential

### 3. Environment variables

Create `.env.local`:

```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
JWT_SECRET=your_jwt_secret
APP_PASSWORD=your_app_password

AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_REGION=us-east-1
S3_BUCKET=your_bucket_name

NEXT_PUBLIC_LIVEKIT_URL=wss://your-ngrok-7880-url

OPENAI_API_KEY=your_openai_key
OPENAI_TRANSCRIPTION_MODEL=whisper-1
```

Generate secrets:
```bash
openssl rand -hex 32   # use for LIVEKIT_API_SECRET and JWT_SECRET
```

### 4. Start Docker stack

```bash
docker compose up -d
docker compose ps      # verify livekit-server, livekit-redis, livekit-egress are running
```

### 5. Start ngrok (two terminals)

```bash
ngrok http 3000
ngrok http 7880
```

Update `NEXT_PUBLIC_LIVEKIT_URL` in `.env.local` with the `wss://` ngrok URL for port 7880 each time it changes.

### 6. Run the app

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) or share the ngrok 3000 URL with guests.

---

## AWS IAM Policy

The IAM user needs this policy on your S3 bucket:

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

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/login` | Password login, returns app JWT |
| POST | `/api/token` | Generate LiveKit room token |
| POST | `/api/egress/start` | Start per-participant track recording |
| POST | `/api/egress/stop` | Stop recording and write metadata |
| POST | `/api/transcription/run` | Trigger transcription for a room |
| GET  | `/api/transcription/estimate` | Estimate transcription cost |

---

## Security Notes

- `egress.yaml`, `livekit.yaml`, and `.env.local` are gitignored — never commit them
- Use `.example` files to share config structure without secrets
- If secrets are ever accidentally pushed, rotate them immediately in AWS IAM and the Metered dashboard

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Guest sees black screen then disconnects | TURN not working — verify Metered credentials in `livekit.yaml` |
| Recording not in S3 | Check AWS credentials in `egress.yaml` and IAM permissions |
| `Failed to start recording` | Ensure `livekit-egress` container is running |
| Can't join room | Verify `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` match across `livekit.yaml`, `egress.yaml`, and `.env.local` |
| ngrok URL changed | Update `NEXT_PUBLIC_LIVEKIT_URL` in `.env.local` and restart `npm run dev` |
| GitHub push blocked — secret detected | Secrets in old commits need a history rewrite, not just `.gitignore` |
