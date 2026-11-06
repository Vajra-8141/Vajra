/**
 * Carries messages between the page and the background. The background takes the site's origin from the browser, not from here, so
 * a page cannot claim to be another site. The port dies when the worker sleeps, and is opened again by the next request.
 */
let port: chrome.runtime.Port | null = null;

function connect() {
  const opened = chrome.runtime.connect({ name: "provider" });
  opened.onMessage.addListener((message) => window.postMessage({ target: "vajra:inpage", ...message }, window.location.origin));
  opened.onDisconnect.addListener(() => {
    port = null;
  });
  return opened;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as { target?: string; id?: number; method?: string; params?: unknown };
  if (data?.target !== "vajra:relay") return;
  port ??= connect();
  port.postMessage({ id: data.id, method: data.method, params: data.params });
});
