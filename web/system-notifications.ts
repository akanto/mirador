import { useEffect, useSyncExternalStore } from "react";
import { bodyWithWorkspace, type SystemNotification } from "../shared/system-notifications.ts";
import { connection } from "./connection.ts";

/** This browser notifies only while you want it to and have allowed the page to; either alone is not enough. */
export interface NotificationSetting {
  wanted: boolean;
  permission: NotificationPermission | "unsupported";
}

const STORAGE_KEY = "mirador-system-notifications";
const listeners = new Set<() => void>();
const supported = typeof Notification !== "undefined";

function storedWanted() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const currentSetting = (): NotificationSetting => ({ wanted: storedWanted(), permission: supported ? Notification.permission : "unsupported" });

let setting = currentSetting();

function refresh() {
  setting = currentSetting();
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useNotificationSetting = () => useSyncExternalStore(subscribe, () => setting);

export const notifies = ({ wanted, permission }: NotificationSetting) => wanted && permission === "granted";

/** Turning them on asks the browser for permission the first time, which it allows only in answer to a click. */
export async function setNotificationsWanted(wanted: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(wanted));
  } catch {}
  if (wanted && supported && Notification.permission === "default") await Notification.requestPermission();
  refresh();
}

function show(notification: SystemNotification, open: (conversationId: string) => void) {
  refresh();
  if (!notifies(setting)) return;
  const shown = new Notification(notification.title, { body: bodyWithWorkspace(notification), tag: notification.conversationId });
  shown.onclick = () => {
    window.focus();
    open(notification.conversationId);
    shown.close();
  };
}

const isLookedAt = () => document.visibilityState === "visible" && document.hasFocus();

/**
 * Keeps the host told which conversation this page shows and whether you are looking at it, and shows the system
 * notifications the host sends about the others. Focus moving into the canvas frame blurs the window for a moment, so
 * the report waits for focus to settle.
 */
export function useSystemNotifications(selectedConversationId: string | null, connected: boolean, open: (conversationId: string) => void) {
  useEffect(() => {
    if (!connected) return;
    const report = () => connection.send({ type: "presence", conversationId: selectedConversationId, attentive: isLookedAt() });
    const reportOnceSettled = () => setTimeout(report);
    report();
    window.addEventListener("focus", reportOnceSettled);
    window.addEventListener("blur", reportOnceSettled);
    document.addEventListener("visibilitychange", reportOnceSettled);
    return () => {
      window.removeEventListener("focus", reportOnceSettled);
      window.removeEventListener("blur", reportOnceSettled);
      document.removeEventListener("visibilitychange", reportOnceSettled);
    };
  }, [selectedConversationId, connected]);

  useEffect(
    () =>
      connection.onMessage((message) => {
        if (message.type === "system-notification") show(message.notification, open);
      }),
    [open],
  );
}
