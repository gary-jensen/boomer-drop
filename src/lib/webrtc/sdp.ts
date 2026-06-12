/** IPs that only work on the same machine — useless to a phone on the network. */
const LOOPBACK_PATTERNS = [
  / 127\.0\.0\.1 /,
  / 127\.0\.0\.1$/,
  / ::1 /,
  / 0\.0\.0\.0 /,
];

export function isUsefulIceCandidate(candidate: string): boolean {
  if (!candidate) return false;
  // Allow mDNS (.local) candidates — Chrome generates these for privacy instead
  // of exposing the real LAN IP. The remote peer resolves them via mDNS and they
  // enable direct host-to-host connections. Filtering them forces STUN-only paths
  // which can be 10–50× slower on a local network.
  return !LOOPBACK_PATTERNS.some((pattern) => pattern.test(candidate));
}

function extractUdpPort(sdp: string): string | null {
  const loopback = sdp.match(
    /a=candidate:\S+ \d+ udp \d+ 127\.0\.0\.1 (\d+) typ host/
  );
  if (loopback?.[1]) return loopback[1];

  const anyHost = sdp.match(
    /a=candidate:\S+ \d+ udp \d+ (\d+\.\d+\.\d+\.\d+) (\d+) typ host/
  );
  if (anyHost?.[2]) return anyHost[2];

  const srflx = sdp.match(
    /a=candidate:\S+ \d+ udp \d+ (\d+\.\d+\.\d+\.\d+) (\d+) typ srflx/
  );
  return srflx?.[2] ?? null;
}

/**
 * When the host runs on localhost, browsers often only advertise 127.0.0.1.
 * Inject the LAN IP (same UDP port as loopback) so phones on Wi-Fi can connect.
 */
export function injectLanHostCandidate(sdp: string, lanHost: string): string {
  if (!lanHost || sdp.includes(lanHost)) return sdp;

  const port = extractUdpPort(sdp);
  if (!port) return sdp;

  const udpLine = `a=candidate:4234997325 1 udp 2122129151 ${lanHost} ${port} typ host generation 0 network-id 1`;
  const tcpLine = `a=candidate:4234997326 1 tcp 2105524479 ${lanHost} ${port} typ host tcptype passive generation 0 network-id 1`;

  const lines = sdp.split(/\r?\n/);
  const endIdx = lines.findIndex((line) => line.startsWith("a=end-of-candidates"));
  const insertIdx =
    endIdx >= 0
      ? endIdx
      : lines.reduce(
          (last, line, index) => (line.startsWith("a=candidate:") ? index : last),
          -1
        ) + 1;

  if (insertIdx <= 0) return sdp;

  lines.splice(insertIdx, 0, udpLine, tcpLine);
  return lines.join("\r\n");
}

/** Remove loopback / mDNS candidates from SDP. */
export function sanitizeSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const kept = lines.filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    return isUsefulIceCandidate(line);
  });

  return kept.join("\r\n");
}

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

export interface PrepareSdpOptions {
  lanHost?: string | null;
  injectLan?: boolean;
}

/**
 * Inject high-bandwidth hints into the data channel media section:
 *   b=AS:1000000  — tells the SCTP stack the application wants up to 1 Gbps
 *   max-message-size — raise from the default 65536 to 1 MB so SCTP can use
 *                      larger internal segments, reducing per-message overhead
 */
function injectDataChannelBandwidth(sdp: string): string {
  // Add b=AS after the m=application line (only if not already present)
  let result = sdp.replace(
    /(m=application[^\r\n]*\r?\n)(?!b=AS:)/,
    "$1b=AS:1000000\r\n"
  );
  // Raise max-message-size
  result = result.replace(
    /a=max-message-size:\d+/g,
    "a=max-message-size:1048576"
  );
  // If max-message-size line is absent, inject it after a=sctp-port line
  if (!result.includes("a=max-message-size:")) {
    result = result.replace(
      /(a=sctp-port:\d+\r?\n)/,
      "$1a=max-message-size:1048576\r\n"
    );
  }
  return result;
}

export function prepareSessionDescription(
  desc: RTCSessionDescriptionInit,
  options?: PrepareSdpOptions
): RTCSessionDescriptionInit {
  if (!desc.sdp) return desc;

  let sdp = desc.sdp;
  if (options?.injectLan && options.lanHost) {
    sdp = injectLanHostCandidate(sdp, options.lanHost);
  }
  sdp = sanitizeSdp(sdp);
  sdp = injectDataChannelBandwidth(sdp);

  return { type: desc.type, sdp };
}
