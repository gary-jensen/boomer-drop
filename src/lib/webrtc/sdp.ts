/** Summarize ICE candidates in an SDP for debug logging. */
export function summarizeCandidates(sdp: string): string {
  const candidates = sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:"));

  if (candidates.length === 0) return "no ICE candidates";

  const ips = new Set<string>();
  for (const line of candidates) {
    const parts = line.split(" ");
    const ip = parts[4];
    if (ip) ips.add(ip);
  }

  return `${candidates.length} candidates [${[...ips].join(", ")}]`;
}
