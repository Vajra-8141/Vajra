import { createRoot } from "react-dom/client";
import { App } from "./app";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
