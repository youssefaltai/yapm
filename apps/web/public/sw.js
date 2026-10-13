// yapm service worker: shows Web Push notifications and opens the right screen on tap.
// It doesn't cache anything; the app always loads fresh from the hub.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "yapm", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "yapm", {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/inbox" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/inbox", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === url.origin && "focus" in client) {
          await client.focus();
          // The app's router listens for this and navigates without a reload.
          client.postMessage({ type: "navigate", path: url.pathname });
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});

// The browser may rotate a subscription; without telling the hub, pushes would silently stop.
self.addEventListener("pushsubscriptionchange", (event) => {
  const graphql = (query, variables) =>
    fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query, variables }),
    }).then((response) => response.json());
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription;
      if (!subscription) {
        const { data } = await graphql("{ pushVapidPublicKey }");
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: data.pushVapidPublicKey,
        });
      }
      await graphql(
        "mutation($data: String!, $ua: String) { pushSubscriptionCreate(input: { data: $data, userAgent: $ua }) { success } }",
        { data: JSON.stringify(subscription), ua: navigator.userAgent },
      );
    })(),
  );
});
