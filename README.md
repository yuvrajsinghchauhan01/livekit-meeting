# LiveKit Meeting App

A full-featured video meeting application with **per-participant recording to S3**, built with Next.js 14, LiveKit, and Docker.

## Architecture

```
Browser (Next.js)
    │
    ├── /api/auth/login     → validates APP_PASSWORD, issues app JWT
    ├── /api/token          → issues LiveKit room token (JWT-protected)
    ├── /api/egress/start   → starts ParticipantEgress (JWT-protected)
    └── /api/egress/stop    → stops egress by ID (JWT-protected)

Docker Compose
    ├── livekit-server      → ws://localhost:7880
    ├── redis               → session/room state
    └── livekit-egress      → records tracks → uploads to S3

TURN (Media Relay)
    └── Metered.ca hosted TURN → global.relay.metered.ca
        (handles UDP/TCP media relay for guests behind NAT/firewall)
```

### S3 Recording Path Structure
```
livekit-recordings-yuvraj/
└── recordings/
    └── <meeting-name>/
        ├── Alice.mp4
        ├── Bob.mp4
        └── Charlie.mp4
```

---

## How Networking Works (Local Dev with ngrok)

This app runs locally on a Mac and is exposed to the internet via two ngrok tunnels:

| Tunnel | Port | Purpose |
|---|---|---|
| ngrok #1 | 3000 | Next.js app (share this URL with guests) |
| ngrok #2 | 7880 | LiveKit signaling (WebSocket) |

**Why two tunnels?**
- Port 3000 serves the web app
- Port 7880 is the LiveKit WebSocket signaling endpoint — guests need to reach it directly

**Why not more tunnels?**
Previously a local coturn TURN server was used, which required exposing UDP ports (7881, 7882, 3478, 49152-49200). ngrok doesn't support UDP, so media would fail after a few seconds.

**Current fix:** Metered.ca hosted TURN handles all media relay. No UDP ports need to be exposed locally. The two ngrok tunnels (3000 + 7880) are sufficient.

### Starting ngrok

Run these in two separate terminals:

```bash
ngrok http 3000
ngrok http 7880
```

Then update `.env.local`:
```
NEXT_PUBLIC_LIVEKIT_URL=wss://<your-7880-ngrok-url>
```

And share the `https://<your-3000-ngrok-url>` with guests.

---

## Quick Start

### 1. Prerequisites

- Docker & Docker Compose
- Node.js 18+
- AWS S3 bucket named `livekit-recordings-yuvraj`
- Two ngrok tunnels (see above)

### 2. Configure environment

Edit `.env.local`:

| Variable | What to set |
|---|---|
| `LIVEKIT_URL` | `ws://localhost:7880` (server-side, stays local) |
| `NEXT_PUBLIC_LIVEKIT_URL` | `wss://<ngrok-7880-url>` (browser-facing) |
| `LIVEKIT_API_KEY` | Must match `livekit.yaml` → `keys:` key name |
| `LIVEKIT_API_SECRET` | Must match `livekit.yaml` → `keys:` secret value |
| `JWT_SECRET` | Any random 32+ char string — `openssl rand -hex 32` |
| `APP_PASSWORD` | Password users enter to log in |
| `AWS_ACCESS_KEY_ID` | AWS IAM key with S3 write access |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret |
| `AWS_REGION` | e.g. `us-east-1` |
| `S3_BUCKET` | `livekit-recordings-yuvraj` |

Also update **`livekit.yaml`** and **`egress.yaml`** with the same `api_key` / `api_secret` values.

### 3. Start LiveKit stack

```bash
docker compose up -d
```

Verify containers are running:
```bash
docker compose ps
docker compose logs livekit
docker compose logs egress
```

### 4. Install & run Next.js app

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Using the App

1. **Login** — enter any username + the `APP_PASSWORD` from `.env.local`
2. **Create/join room** — type a room name and your display name
3. **Meeting room** — your camera/mic activate automatically
4. **Start Recording** — click **"Record My Track"** in the top bar
5. **Stop Recording** — click **"Stop Recording"** — `.mp4` is uploaded to S3
6. **Leave** — click **"Leave"**

> Each participant controls their own recording. Multiple participants can record simultaneously — each gets their own `.mp4` in S3.

---

## TURN Configuration (Metered.ca)

Media relay is handled by [Metered.ca](https://www.metered.ca/stun-turn) hosted TURN servers. This is configured in `livekit.yaml`:

```yaml
rtc:
  turn_servers:
    - host: global.relay.metered.ca
      port: 80
      protocol: udp
      username: <metered-username>
      credential: <metered-credential>
    - host: global.relay.metered.ca
      port: 80
      protocol: tcp
      username: <metered-username>
      credential: <metered-credential>
    - host: global.relay.metered.ca
      port: 443
      protocol: tcp
      username: <metered-username>
      credential: <metered-credential>
```

If you need to replace the TURN credentials, sign in to [metered.ca](https://www.metered.ca), go to your app's TURN Credentials page, and update the `username` and `credential` fields in `livekit.yaml`.

---

## S3 IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::livekit-recordings-yuvraj",
        "arn:aws:s3:::livekit-recordings-yuvraj/*"
      ]
    }
  ]
}
```

---

## File Structure

```
livekit-meeting/
├── docker-compose.yml          # LiveKit + Redis + Egress
├── livekit.yaml                # LiveKit server config (incl. Metered TURN)
├── egress.yaml                 # Egress config (S3 creds)
├── .env.local                  # App secrets (never commit!)
│
├── app/
│   ├── layout.tsx
│   ├── page.tsx                # Login + lobby
│   ├── globals.css
│   └── api/
│       ├── auth/login/route.ts
│       ├── token/route.ts
│       └── egress/
│           ├── start/route.ts
│           └── stop/route.ts
│
├── components/
│   ├── MeetingRoom.tsx
│   └── RecordingControls.tsx
│
└── lib/
    ├── auth.ts
    └── livekit.ts
```

---

## Generating Secrets

```bash
openssl rand -hex 32   # for LIVEKIT_API_SECRET and JWT_SECRET
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Guest sees gray/black screen then gets kicked | TURN is not working — verify Metered credentials in `livekit.yaml` |
| Egress container exits immediately | Check `shm_size: "1gb"` and `cap_add: SYS_ADMIN` in docker-compose.yml |
| `Failed to start recording` | Ensure egress container is running and `LIVEKIT_URL` is `ws://localhost:7880` |
| Recording not in S3 | Check AWS credentials in `egress.yaml` and IAM permissions |
| `Invalid credentials` on login | Check `APP_PASSWORD` in `.env.local` |
| Can't join room | Verify `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` match between `livekit.yaml` and `.env.local` |
| ngrok URL changed | Update `NEXT_PUBLIC_LIVEKIT_URL` in `.env.local` and restart `npm run dev` |
