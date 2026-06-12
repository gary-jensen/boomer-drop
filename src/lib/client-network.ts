const PRIVATE_IP =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3})$/;

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/**
 * WebRTC on desktop breaks when you open the app via your own LAN IP
 * instead of localhost — but the other device must keep the LAN IP.
 */
export function ensureDesktopLocalhost(): boolean {
  if (typeof window === "undefined") return true;
  if (isMobileDevice()) return true;

  const { hostname, port, pathname, search } = window.location;
  if (!PRIVATE_IP.test(hostname)) return true;

  const localPort = port || (window.location.protocol === "https:" ? "443" : "3000");
  const protocol = window.location.protocol;
  window.location.replace(`${protocol}//localhost:${localPort}${pathname}${search}`);
  return false;
}
