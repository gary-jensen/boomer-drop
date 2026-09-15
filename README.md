# BoomerDrop

Send files between two devices — no apps, no accounts. Open BoomerDrop, scan the QR code on the other device, confirm the 4-character code matches, and send files.

## Run on ForgeVPS

Requires Node.js 22+, PostgreSQL, and a domain pointing at your VPS for HTTPS.

1. In the machine's **Databases** pane, create `boomer_drop`.
2. Clone the repository and run `npm ci`.
3. Copy `.env.example` to `.env.local`. Set `DATABASE_URL` to the ForgeVPS connection string, and `BOOMER_DROP_PUBLIC_ORIGIN` to your HTTPS origin.
4. Run `npm run db:migrate` and `npm run build`.
5. Start a persistent process with `npm start` (for example, a ForgeVPS server using `npm ci`, `npm run db:migrate && npm run build`, and `npm start` as its install/build/start commands).
6. Point the domain's Caddy configuration to the app's loopback port:

```caddyfile
# Replace the domain and port to match .env.local.
drop.example.com {
    reverse_proxy 127.0.0.1:5012
}
```

Caddy handles HTTPS and WebSocket upgrades on the same domain. Keep PostgreSQL and the application port on loopback. Set `PORT` to the port allocated by ForgeVPS; an environment variable from the process manager takes precedence over `.env.local`.

`npm start` runs the custom Next.js/WebSocket server. Running `next start` directly only provides the HTTP fallback. Use a single PM2 fork process for this deployment. The store supports shared PostgreSQL, and sockets also check for messages written by HTTP or another process once a second.

Health check: `GET /api/health` returns 200 when the database and schema are reachable. Startup fails if the database or migrations are missing.

### What is the database for?

PostgreSQL stores temporary room IDs, pairing codes, and WebRTC offer/answer/ICE messages. It **does not store file contents** or user accounts. Messages allow a disconnected browser to resume signaling from its last cursor. Rooms expire after 10 minutes without signaling activity; the server deletes expired rooms and their messages every minute. An open signaling connection keeps its room alive.

ForgeVPS manages the database's credentials, browsing, and backup settings. Its backups can retain expired metadata beyond the live database's 10-minute lifetime; adjust backup settings in the Databases pane if desired. Runtime credentials belong in `.env.local` or ForgeVPS environment settings, never in Git.

### Migrating from Vercel

Supabase Realtime, Redis, and Vercel KV are no longer required. Replace their environment variables with `DATABASE_URL`, run the migration, and use `npm start`. Old transient rooms are not imported: open the new site and scan a fresh QR code. The migration creates the schema without dropping existing tables.

File transfer remains encrypted WebRTC between devices. The VPS carries connection setup messages. Networks that block direct peer connections still require TURN; the existing optional Cloudflare TURN credentials are supported. Moving signaling to a VPS does not by itself make it a TURN relay.

## Development and verification

```bash
npm ci
# Configure .env.local with a development PostgreSQL database.
npm run db:migrate
npm run dev
```

Open `http://localhost:3000` (or the configured port). Set `HOST=0.0.0.0` and `BOOMER_DROP_PUBLIC_HOST` for LAN development. Phones require a trusted HTTPS origin. `npm run dev:https` is an optional Next.js development server with a self-signed certificate and HTTP signaling fallback.

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Integration tests require a migrated PostgreSQL database. They create isolated random rooms and remove them afterward; use a development database. Tests cover actual WebSocket delivery/acknowledgments, reconnect cursors, concurrent writes, room isolation, expiry, and origin rejection.

## Stack

Next.js App Router · React · TypeScript · Tailwind CSS · native WebSockets (`ws`) · PostgreSQL · WebRTC data channels.
