/** What the extension's own pages share. Text always goes in as text: an address or a site's name is not ours to trust. */
export function h(tag: string, attrs: Record<string, string | boolean | (() => void)> = {}, ...children: (Node | string | null)[]) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") el.addEventListener(name, value);
    else if (value === true) el.setAttribute(name, "");
    else if (value !== false) el.setAttribute(name, value);
  }
  for (const child of children) if (child !== null) el.append(child);
  return el;
}

export async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(message)) as { value?: T; error?: string } | undefined;
  if (!reply) throw new Error("the wallet did not answer");
  if (reply.error) throw new Error(reply.error);
  return reply.value as T;
}

export const field = (id: string, placeholder: string, type = "text") => h("input", { id, placeholder, type, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
