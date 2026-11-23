import { showToast } from "../app/toasts";
import { showQuickPick } from "../plugins/surfaces";
import { confirm, prompt as nativePrompt } from "../../platform/dialogs";
import type { QuickPickItem } from "../../lib/pluginProtocol";

export function say(windowId: string | undefined, title: string, message?: string) {
  if (windowId) showToast(windowId, title, message);
  else void confirm({ title, message: message ?? "", confirmTitle: "OK" });
}

export function prompt(windowId: string | undefined, title: string, options: { message?: string; placeholder?: string; password?: boolean } = {}): Promise<string | null> {
  const placeholder = options.password ? "Master password" : (options.placeholder ?? "");
  return nativePrompt({ title, message: options.message ?? "", placeholder, confirmTitle: "Continue", ...(windowId ? { windowId } : {}), secure: options.password === true }).catch(() => null);
}

export function pick(plugin: string, windowId: string, items: QuickPickItem[], title: string, placeholder?: string): Promise<string | null> {
  const asked = showQuickPick(plugin, windowId, items, { title, placeholder });
  if (asked) return asked.then((picked) => picked?.[0] ?? null);
  say(windowId, "Finish the open prompt first");
  return Promise.resolve(null);
}
