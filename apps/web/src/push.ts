import { useEffect, useState } from "react";
import { graphql } from "./api.js";
import { mutate, toast } from "./data.js";
import { navigate } from "./router.js";

// Web Push for the installed app. iPhones support it only once yapm is added to the
// Home Screen, so the Inbox explains that step when it's missing.

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
  // A tapped notification asks an open window to show its screen.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; path?: string } | null;
    if (data?.type === "navigate" && data.path) navigate(data.path);
  });
}

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

function keyBytes(base64url: string) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export type PushState = "unsupported" | "install-first" | "off" | "on" | "blocked";

export function usePushState(): [PushState, () => Promise<void>] {
  const [state, setState] = useState<PushState>("unsupported");
  useEffect(() => {
    if (!supported()) {
      setState(isIos() && !installed() ? "install-first" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "on" : "off"));
  }, []);

  async function turnOn() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState(permission === "denied" ? "blocked" : "off");
      return;
    }
    try {
      const { pushVapidPublicKey } = await graphql<{ pushVapidPublicKey: string }>(
        "{ pushVapidPublicKey }",
      );
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(pushVapidPublicKey),
      });
      const saved = await mutate(
        "mutation($data: String!, $ua: String) { pushSubscriptionCreate(input: { data: $data, userAgent: $ua }) { success } }",
        { data: JSON.stringify(subscription), ua: navigator.userAgent },
      );
      if (saved) {
        setState("on");
        toast("Notifications are on");
      }
    } catch (error) {
      toast(`Couldn't turn on notifications: ${error instanceof Error ? error.message : error}`);
    }
  }
  return [state, turnOn];
}
