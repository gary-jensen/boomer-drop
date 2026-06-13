/** Keep the screen awake during active transfers (Safari/iOS). */

let lock: WakeLockSentinel | null = null;
let refCount = 0;

export async function acquireWakeLock(): Promise<void> {
  refCount += 1;
  if (refCount > 1 || lock) return;

  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

  try {
    lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => {
      lock = null;
    });
  } catch {
    // Permission denied or unsupported — non-fatal.
  }
}

export async function releaseWakeLock(): Promise<void> {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0 || !lock) return;

  try {
    await lock.release();
  } catch {
    // ignore
  }
  lock = null;
}

/** Re-acquire after visibility change (Safari releases wake lock when tab hides). */
export async function refreshWakeLockIfNeeded(): Promise<void> {
  if (refCount <= 0) return;
  if (lock) return;
  await acquireWakeLock();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshWakeLockIfNeeded();
    }
  });
}
