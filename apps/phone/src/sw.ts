/**
 * Keeps the app's shell for offline start, and turns a push into a notification.
 *
 * A notification only opens the review screen. Nothing here can answer an item: that takes a tap in the app, and for Pay the passkey.
 * API replies are never cached, so a stale queue cannot be shown as a live one.
 */
export {};
declare const self: ServiceWorkerGlobalScope;

const CACHE = "vajra-shell-v1";
const SHELL = ["/", "/app.js", "/style.css", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(event.request)) ?? Response.error()));
});

self.addEventListener("push", (event) => {
  const data = (event.data?.json() ?? {}) as { title?: string; body?: string; id?: string };
  event.waitUntil(
    self.registration.showNotification(data.title ?? "VAJRA", {
      body: data.body ?? "Something is waiting on your account.",
      icon: "/icon-192.png",
      tag: `item-${data.id ?? "unknown"}`,
      requireInteraction: true,
      data: { id: data.id },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = (event.notification.data as { id?: string } | undefined)?.id;
  const target = id ? `/#item=${id}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (!open) return self.clients.openWindow(target);
      return open.navigate(target).then((client) => (client ?? open).focus());
    }),
  );
});
