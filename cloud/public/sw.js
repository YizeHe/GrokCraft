const CACHE = "grokcraft-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/") || url.pathname.startsWith("/browser/")) {
    return;
  }
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((hit) => hit || caches.match("/"))),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "notify" && self.registration.showNotification) {
    event.waitUntil(
      self.registration.showNotification(data.title || "Grokcraft", {
        body: data.body || "任务已完成",
        icon: "/favicon.svg",
        tag: data.tag || "grokcraft-done",
      }),
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow("/app");
    }),
  );
});
