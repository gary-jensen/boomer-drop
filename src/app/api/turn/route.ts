import { normalizeIceServers } from "@/lib/webrtc/ice";

const GOOGLE_STUN: RTCIceServer = {
  urls: "stun:stun.l.google.com:19302",
};

export async function GET() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!keyId || !apiToken) {
    return Response.json({ iceServers: [GOOGLE_STUN] });
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
      }
    );

    if (!response.ok) {
      return Response.json({ iceServers: [GOOGLE_STUN] });
    }

    const data = (await response.json()) as { iceServers?: unknown };
    return Response.json({
      iceServers: normalizeIceServers(data.iceServers),
    });
  } catch {
    return Response.json({ iceServers: normalizeIceServers([GOOGLE_STUN]) });
  }
}
