/**
 * Keeps the app's shell for offline start, and turns a push into a notification that opens the queue.
 * Only the shell is cached. Chain data is never cached, so a stale balance or queue cannot be shown as live.
 */
export {};
declare const self: ServiceWorkerGlobalScope;

const CACHE = "vajra-wallet-v1";
const SHELL = ["/", "/app.js", "/style.css", "/tokens.css", "/manifest.webmanifest", "/icon-192.png", "/fonts/Geist-Variable.woff2", "/fonts/GeistMono-Variable.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const shell = event.request.mode === "navigate" ? "/" : url.pathname;
  if (!SHELL.includes(shell)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(shell, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(shell)) ?? Response.error()),
  );
});

self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; id?: string } = {};
  try {
    data = (event.data?.json() ?? {}) as typeof data;
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "A payment is waiting", {
      body: data.body ?? "Open VAJRA to see it. If it isn't you, tap Not me.",
      icon: "/icon-192.png",
      tag: `queue-${data.id ?? "item"}`,
      requireInteraction: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = "/#/queue";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (!open) return self.clients.openWindow(target);
      return open.navigate(target).then((client) => (client ?? open).focus());
    }),
  );
});
