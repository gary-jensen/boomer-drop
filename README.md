# BoomerDrop

Send files between two devices — no apps, no accounts. Open BoomerDrop on your computer, scan the QR code on the other device, confirm the 4-character code matches, and drop your files.

## Quick start

```bash
npm install
npm run dev
```

Add to `.env.local`:

```
BOOMER_DROP_PUBLIC_HOST=10.0.0.23
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

**On your computer:** open `http://localhost:3000`

**On the other device:** scan the QR code (uses the LAN IP you set above)

### Local dev with an iPhone

iPhones require **HTTPS** for WebRTC over a LAN IP. Use:

```bash
npm run dev:https
```

Open `https://localhost:3000` on your computer (accept the certificate warning). The scanned QR will use `https://10.0.0.23:3000` — accept the warning on the phone too.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BOOMER_DROP_PUBLIC_HOST` | Local dev | Your computer's LAN IP for QR codes |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL (Realtime signaling) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes* | Supabase publishable key (`sb_publishable_…`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes* | Legacy anon JWT (alternative to publishable key) |
| `REDIS_URL` | Production | Redis for room metadata |
| `CLOUDFLARE_TURN_KEY_ID` | Optional | Cloudflare TURN key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | Optional | Cloudflare TURN API token |

### Supabase Realtime setup

1. Create a free project at [supabase.com](https://supabase.com)
2. Copy the project URL and anon key into `.env.local` / Vercel env vars
3. Realtime is enabled by default — no database tables needed for signaling

Free tier includes **200 concurrent WebSocket connections** (~100 simultaneous transfer pairs).

**Local dev without Redis:** room creation falls back to in-memory storage (single process only).

**Without TURN:** Google STUN is used as a fallback. Cross-network transfers may need Cloudflare TURN.

## Deploy to Vercel

1. Push to GitHub and import the project in [Vercel](https://vercel.com).
2. Add Redis (`REDIS_URL`), Supabase URL + anon key, and optional TURN credentials.
3. Deploy.

## How it works

- **QR pairing** — Host creates a room; the other device scans the QR to open `/join/[roomId]`.
- **Verification code** — Both devices derive the same 4-character code from the room ID.
- **WebRTC data channel** — Files transfer peer-to-peer over an encrypted DTLS channel.
- **Supabase Realtime** — WebRTC offer/answer/ICE pushed instantly over WebSockets (no HTTP polling).
- **Partition acks** — 1 MB partitions with receiver acks for Safari-friendly throughput and resume on reconnect.
- **Wake lock** — Screen stays awake during transfers so iOS doesn't suspend the tab.
- **Auto-download** — Optional; notifies you when files arrive while the tab is in the background.
- **PWA** — Add to Home Screen for a standalone app experience.

## Stack

- Next.js (App Router) · React · TypeScript · Tailwind CSS v4
- Supabase Realtime (signaling) · Redis (room metadata)
- WebRTC `RTCPeerConnection` + `RTCDataChannel`
