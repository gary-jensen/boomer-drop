import { networkInterfaces } from "os";

export function getLocalIpv4(): string | null {
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }

  return null;
}

/** Hostname only — port always comes from the running dev server. */
function configuredLanHost(): string | null {
  return process.env.BOOMER_DROP_PUBLIC_HOST?.trim() ?? null;
}

function isUnreachableDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::]" ||
    hostname === "::"
  );
}

/** Use LAN IP instead of localhost / 0.0.0.0 so phones can reach the dev server. */
export function getJoinOrigin(request: Request): string {
  const url = new URL(request.url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  if (!isUnreachableDevHost(url.hostname)) {
    return url.origin;
  }

  const lanHost = configuredLanHost() ?? getLocalIpv4();
  if (lanHost) {
    return `${url.protocol}//${lanHost}:${port}`;
  }

  return url.origin;
}
