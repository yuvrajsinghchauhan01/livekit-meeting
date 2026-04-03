# LiveKit Meeting App

Self-hosted video meeting app with per-participant audio recording to S3. Built with Next.js 14, LiveKit, and Docker.

---

## Stack

- **Next.js 14** — frontend + API routes
- **LiveKit** (self-hosted) — WebRTC signaling and media server
- **LiveKit Egress** — records each participant's audio track as `.ogg` → uploads to S3
- **Redis** — LiveKit session/room state
- **Metered.ca TURN** — hosted TURN relay so guests behind NAT/firewall can connect
- **AWS S3** — stores recordings

---

## How It Works

Two ngrok tunnels expose the app to the internet from your Mac:

| Tunnel | Port | Purpose |
|---|---|---|
| ngrok #1 | 3000 | Next.js app — share this URL with guests |
| ngrok #2 | 7880 | LiveKit signaling (WebSocket) |

Media (audio/video) flows through Metered.ca's hosted TURN servers — no UDP ports need to be exposed locally.

Recording flow:
1. Participant joins → mic track is published
2. Backend starts a LiveKit TrackEgress for that participant
3. On leave → egress stops, `.ogg` file is finalized and uploaded to S3
4. A `.json` metadata file is written alongside each recording

S3 path structure:
```
<bucket>/
└── recordings/
    └── <room-name>/
        └── <stable-identity>/
            ├── TR_<trackSid>.ogg
            └── EG_<trackSid>.json
```

> Participant identity is a stable hash of `username:roomName` — so reconnects and display name changes don't create duplicate folders.

---

## Setup

### 1. Prerequisites

- Docker + Docker Compose
- Node.js 18+
- AWS S3 bucket
- Two ngrok tunnels running
- Metered.ca account (free tier) for TURN credentials

### 2. Config files

These files are gitignored and must be created locally. Use the `.example` files as templates:

```bash
cp egress.yaml.example egress.yaml
cp livekit.yaml.example livekit.yaml
```

Fill in `egress.yaml`:
- `api_key` / `api_secret` — must match `livekit.yaml` and `.env.local`
- `s3.access_key` / `s3.secret` — AWS IAM credentials
- `s3.region` / `s3.bucket` — your S3 bucket details

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
```

Generate secrets:
```bash
openssl rand -hex 32   # use for LIVEKIT_API_SECRET and JWT_SECRET
```

### 4. Start Docker stack

```bash
docker compose up -d
docker compose ps      # verify all 3 containers are running
```

Containers: `livekit-server`, `livekit-redis`, `livekit-egress`

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

## Security Notes

- `egress.yaml`, `livekit.yaml`, and `.env.local` are all gitignored — never commit them
- Use `.example` files to share config structure without secrets
- If secrets are ever accidentally pushed, rotate them immediately in AWS IAM / Metered dashboard

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Guest sees gray/black screen then disconnects | TURN not working — verify Metered credentials in `livekit.yaml` |
| Multiple `.ogg` / `.json` files per person | Fixed — egress deduplication is handled server-side |
| Recording not in S3 | Check AWS credentials in `egress.yaml` and IAM permissions |
| `Failed to start recording` | Ensure `livekit-egress` container is running |
| Can't join room | Verify `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` match across `livekit.yaml`, `egress.yaml`, and `.env.local` |
| ngrok URL changed | Update `NEXT_PUBLIC_LIVEKIT_URL` in `.env.local` and restart `npm run dev` |
| GitHub push blocked — secret detected | Check git history with `git log` — secrets in old commits need history rewrite, not just `.gitignore` |
