const AUTO_DOWNLOAD_KEY = "boomerdrop-auto-download";

export function getAutoDownloadEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(AUTO_DOWNLOAD_KEY);
  if (stored === null) return true;
  return stored === "true";
}

export function setAutoDownloadEnabled(enabled: boolean): void {
  localStorage.setItem(AUTO_DOWNLOAD_KEY, String(enabled));
}
