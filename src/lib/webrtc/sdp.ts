/** Parse an SDP `a=candidate:` line or candidate string into a short label. */
export function formatIceCandidate(candidate: string): string {
  const line = candidate.startsWith("a=candidate:")
    ? candidate
    : `a=candidate:${candidate}`;

  const parts = line.split(" ");
  const ip = parts[4] ?? "?";
  const protocol = parts[2] ?? "?";
  const typIdx = parts.indexOf("typ");
  const type = typIdx >= 0 ? parts[typIdx + 1] : "?";
  const displayIp = ip.includes(".local") ? "mdns" : ip;

  return `${type}/${protocol}@${displayIp}`;
}

/** Summarize ICE candidates in an SDP for debug logging. */
export function summarizeCandidates(sdp: string): string {
  const lines = sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:"));

  if (lines.length === 0) return "no ICE candidates";

  const types = new Map<string, number>();
  const ips = new Set<string>();

  for (const line of lines) {
    const parts = line.split(" ");
    const ip = parts[4];
    if (ip) ips.add(ip.includes(".local") ? "mdns" : ip);
    const typIdx = parts.indexOf("typ");
    const type = typIdx >= 0 ? parts[typIdx + 1] : "?";
    types.set(type, (types.get(type) ?? 0) + 1);
  }

  const typeSummary = [...types.entries()]
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  return `${lines.length} candidates (${typeSummary}) [${[...ips].join(", ")}]`;
}
