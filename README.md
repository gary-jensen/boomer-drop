# BoomerDrop

Send files between two devices — no apps, no accounts. Open BoomerDrop on your computer, scan the QR code on the other device, confirm the 4-character code matches, and drop your files.

## Quick start

```bash
npm install
npm run dev
```

Add your computer's LAN IP to `.env.local` so the QR code points to an address the other device can reach:

```
BOOMER_DROP_PUBLIC_HOST=10.0.0.23
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

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Description |
|---|---|---|
| `BOOMER_DROP_PUBLIC_HOST` | Local dev | Your computer's LAN IP for QR codes |
| `KV_REST_API_URL` | Production | Vercel KV REST API URL (auto-set when linked) |
| `KV_REST_API_TOKEN` | Production | Vercel KV REST API token |
| `CLOUDFLARE_TURN_KEY_ID` | Optional | Cloudflare TURN key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | Optional | Cloudflare TURN API token |

**Local dev without KV:** if the KV variables are absent, signaling falls back to in-memory storage. This only works with a single server process.

**Without TURN:** Google STUN is used as a fallback. Transfers across different networks (e.g. cellular ↔ Wi-Fi) may fail to connect without TURN.

## Deploy to Vercel

1. Push to GitHub and import the project in [Vercel](https://vercel.com).
2. Link a **KV** store from the Vercel dashboard (Storage → KV).
3. Optionally add Cloudflare TURN credentials under Project Settings → Environment Variables.
4. Deploy.

## How it works

- **QR pairing** — Host creates a room; the other device scans the QR to open `/join/[roomId]`.
- **Verification code** — Both devices derive the same 4-character code from the room ID. Confirm they match before sending.
- **WebRTC data channel** — Files transfer peer-to-peer over an encrypted DTLS channel. Nothing passes through the server.
- **Signaling** — Ephemeral WebRTC offer/answer/ICE messages are exchanged via Vercel KV (600 s TTL).
- **TURN** — Cloudflare TURN helps with connections through restrictive networks (firewalls, double-NAT, cellular).
- **Backpressure** — The sender pauses when the data channel buffer fills up, preventing data loss on large files.

## Stack

- Next.js (App Router) · React · TypeScript · Tailwind CSS v4
- `@vercel/kv` for signaling storage
- `qrcode` for QR generation
- WebRTC `RTCPeerConnection` + `RTCDataChannel` (no third-party WebRTC library)
