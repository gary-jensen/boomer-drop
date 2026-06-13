const APP_TITLE = "BoomerDrop";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function notifyFileReceived(fileName: string): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;

  try {
    const notification = new Notification(APP_TITLE, {
      body: `Received ${fileName}`,
      icon: "/icon.svg",
      tag: `received-${fileName}`,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers require service worker for notifications.
  }
}

export function notifyTransferComplete(count: number): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;

  const body =
    count === 1
      ? "File transfer complete — tap to open"
      : `${count} files received — tap to open`;

  try {
    const notification = new Notification(APP_TITLE, {
      body,
      icon: "/icon.svg",
      tag: "transfer-complete",
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // ignore
  }
}
