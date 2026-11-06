/**
 * Runs in the page. This is the EIP-1193 provider a dapp sees, announced by EIP-6963. It holds nothing and decides nothing: every request
 * goes to the background through the relay. Anything on this side can be tampered with by the page, so nothing here is trusted.
 */
type Listener = (...args: unknown[]) => void;

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230c0e11'/%3E%3Cpath d='M16 6l10 10-10 10L6 16z' fill='%23f2b632'/%3E%3C/svg%3E";

const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, Set<Listener>>();
let nextId = 1;

const emit = (event: string, ...args: unknown[]) => {
  for (const listener of listeners.get(event) ?? []) listener(...args);
};

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as { target?: string; id?: number; result?: unknown; error?: { code: number; message: string }; event?: string; payload?: unknown };
  if (data?.target !== "vajra:inpage") return;
  if (data.event) return emit(data.event, data.payload);
  const pending = waiting.get(data.id!);
  if (!pending) return;
  waiting.delete(data.id!);
  if (data.error) pending.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
  else pending.resolve(data.result);
});

const provider = {
  isVajra: true,
  request({ method, params }: { method: string; params?: unknown[] | object }) {
    if (typeof method !== "string") return Promise.reject(Object.assign(new Error("request needs a method"), { code: -32600 }));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      window.postMessage({ target: "vajra:relay", id, method, params }, window.location.origin);
    });
  },
  on(event: string, listener: Listener) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
    return provider;
  },
  removeListener(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return provider;
  },
  isConnected: () => true,
};

const detail = Object.freeze({
  info: Object.freeze({ uuid: crypto.randomUUID(), name: "VAJRA", icon: ICON, rdns: "io.github.vajra-8141" }),
  provider: Object.freeze(provider),
});
const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
window.addEventListener("eip6963:requestProvider", announce);
announce();

// Another wallet may have got here first, and this does not take over from it. EIP-6963 is how a dapp finds this one then.
if (!("ethereum" in window)) Object.defineProperty(window, "ethereum", { value: detail.provider, configurable: true, writable: true });
