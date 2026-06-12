const GOOGLE_STUN: RTCIceServer = {
  urls: "stun:stun.l.google.com:19302",
};

function serverKey(server: RTCIceServer): string {
  const urls = Array.isArray(server.urls) ? server.urls.join("|") : server.urls;
  return urls;
}

export function normalizeIceServers(servers: unknown): RTCIceServer[] {
  const raw = Array.isArray(servers)
    ? servers
    : servers
      ? [servers as RTCIceServer]
      : [];

  const seen = new Set<string>();
  const normalized: RTCIceServer[] = [];

  for (const server of [GOOGLE_STUN, ...raw]) {
    if (!server?.urls) continue;
    const key = serverKey(server);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(server);
  }

  return normalized.length > 0 ? normalized : [GOOGLE_STUN];
}

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch("/api/turn");
    if (!response.ok) return normalizeIceServers([GOOGLE_STUN]);

    const data = (await response.json()) as { iceServers?: unknown };
    return normalizeIceServers(data.iceServers);
  } catch {
    return normalizeIceServers([GOOGLE_STUN]);
  }
}
