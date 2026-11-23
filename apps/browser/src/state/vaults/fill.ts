import { webviews } from "../../platform/webviews";
import { choose } from "../../platform/dialogs";
import { ask, type Space, type VaultItem } from "./store";
import { generatePassword, updateLogin } from "./logins";
import { vaultLoginSubmitted } from "./save";
import { prompt, say } from "./prompts";

export function fillScript(origin: string, values: Record<string, string>): string {
  return `post("result", JSON.stringify((() => {
  const origin = ${JSON.stringify(origin)};
  const values = ${JSON.stringify(values)};
  if (location.origin !== origin) return "navigated";
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const usable = (el) => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && el.getClientRects().length > 0;
  const set = (el, value) => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (values.totp) {
    if (!usable(active)) return "noField";
    set(active, values.totp);
    return "filled";
  }
  const scope = (usable(active) && active.form) || document;
  const inputs = [...scope.querySelectorAll("input")].filter(usable);
  const passwords = inputs.filter((el) => el.type === "password");
  const password = usable(active) && active.type === "password" ? active : passwords[0];
  const texty = (el) => ["text", "email", "tel", ""].includes(el.type);
  let username = usable(active) && texty(active) ? active : null;
  if (!username && password) username = inputs.slice(0, inputs.indexOf(password)).filter(texty).pop() || null;
  if (!username) username = inputs.find(texty) || null;
  if (values.username && username) set(username, values.username);
  if (values.password && password) set(password, values.password);
  return password || username ? "filled" : "noField";
})()))`;
}

export function newPasswordScript(origin: string, password: string): string {
  return `post("result", JSON.stringify((() => {
  const origin = ${JSON.stringify(origin)};
  const password = ${JSON.stringify(password)};
  if (location.origin !== origin) return { filled: 0 };
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const usable = (el) => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && el.getClientRects().length > 0;
  const inField = usable(active);
  const scope = (inField && active.form) || document;
  const inputs = [...scope.querySelectorAll("input")].filter(usable);
  const passwords = inputs.filter((el) => el.type === "password");
  const at = inField && active.type === "password" ? passwords.indexOf(active) : -1;
  const empty = passwords.filter((el) => !el.value);
  const targets = at >= 0 ? passwords.filter((el, i) => i === at || (i > at && !el.value)) : passwords.length <= 2 ? empty : [];
  for (const el of targets) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, password);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (inField) active.focus();
  const before = inputs.slice(0, inputs.indexOf(passwords[0])).filter((el) => ["text", "email", "tel", ""].includes(el.type) && el.value);
  return { filled: targets.length, username: before.length ? before[before.length - 1].value : "" };
})()))`;
}

export function fieldRectScript(): string {
  return `post("result", JSON.stringify((() => {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  if (!active || active === document.body || active === document.documentElement) return null;
  const r = active.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
})()))`;
}

export type FieldRect = { x: number; y: number; width: number; height: number };

export async function focusedFieldRect(tabId: string): Promise<FieldRect | null> {
  const read = await webviews.get(tabId)?.evaluate<unknown>(fieldRectScript()).catch(() => null);
  if (!read || typeof read !== "object") return null;
  const { x, y, width, height } = read as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: x as number, y: y as number, width: width as number, height: height as number } : null;
}

type Login = VaultItem & { space: Space };

export type FillPlace = { title: string; origin: string; host: string; wantsCode: boolean; tabId: string; windowId: string };

export function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

export async function fillLogin(login: Login, place: FillPlace, chosen = false): Promise<void> {
  const { origin, wantsCode, tabId, windowId, title } = place;
  const input: Record<string, unknown> = { id: login.id, origin, ...(chosen ? { chosen: true } : {}) };
  if (login.reprompt) {
    const masterPassword = await prompt(windowId, `Fill ${login.title}`, { message: "Enter your master password to use this login.", password: true });
    if (!masterPassword) return;
    input.masterPassword = masterPassword;
  }
  const answer = wantsCode ? await ask(login.space, "totp", input) : await ask(login.space, "fill", { ...input, fields: ["username", "password"] });
  if (!answer.ok) return say(windowId, `${title} didn't fill`, answer.message);
  const values = wantsCode ? { totp: String(answer.result.code ?? "") } : ((answer.result.values ?? {}) as Record<string, string>);
  const view = webviews.get(tabId);
  if (!view) return;
  const filled = await view.evaluate<string>(fillScript(origin, values)).catch(() => null);
  if (filled === "noField") say(windowId, "Nothing to fill", "Click the field you want to fill, then try again.");
}

export async function fillElsewhere(login: Login, place: FillPlace): Promise<void> {
  const { origin, host, windowId } = place;
  const saved = [...new Set(login.uris.map((u) => hostOf(u.uri)))];
  const answer = await choose({
    title: `Fill “${login.title}” on ${host}?`,
    message: saved.length
      ? `It's saved for ${saved.slice(0, 2).join(" and ")}${saved.length > 2 ? " and others" : ""}. Only fill it if you trust ${host}.`
      : `It isn't saved for any website. Only fill it if you trust ${host}.`,
    choices: ["Fill and Remember Site", "Fill Once", "Cancel"],
    cancelChoice: 2,
    noDefault: true,
    windowId,
  });
  if (answer.choice === 0) {
    const remembered = await updateLogin(login.space, login, { uris: [...login.uris, { uri: origin, match: null }] });
    if (!remembered.ok) return say(windowId, `Couldn't add ${host} to ${login.title}`, remembered.message);
    return fillLogin(login, place);
  }
  if (answer.choice === 1) return fillLogin(login, place, true);
}

export async function useStrongPassword(plugin: string, place: FillPlace): Promise<void> {
  const { origin, tabId, windowId, title } = place;
  const password = await generatePassword(plugin);
  if (!password) return say(windowId, `${title} couldn't make a password`);
  const view = webviews.get(tabId);
  const answer = view ? await view.evaluate<unknown>(newPasswordScript(origin, password)).catch(() => null) : null;
  let filled: { filled?: unknown; username?: unknown } = {};
  try {
    const read: unknown = typeof answer === "string" ? JSON.parse(answer) : answer;
    if (read && typeof read === "object") filled = read as typeof filled;
  } catch {}
  if (typeof filled.filled !== "number" || filled.filled < 1) return say(windowId, "No password field found", "Click the new password field, then try again.");
  await vaultLoginSubmitted(tabId, { username: typeof filled.username === "string" ? filled.username : "", password, main: true });
}
