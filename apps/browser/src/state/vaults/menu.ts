import { useBrowser } from "../browser/store";
import { openSettings, SETTINGS_DETAIL } from "../settings/settingsWindows";
import { patchPage, pageOf } from "../tabs/pageState";
import { regularProfileId } from "../site/passwordManagerChoice";
import type { QuickPickItem } from "../../lib/pluginProtocol";
import { ask, currentVault, loadItems, vaultAccountOf, whyNotReady } from "./store";
import { accountLabels, addAccount, spaceAccounts, type AccountView } from "./accounts";
import { lock, unlock, unlockWithTouchId } from "./unlock";
import { indexLogin, type VaultLogin } from "./search";
import { fillElsewhere, fillLogin, focusedFieldRect, useStrongPassword, type FieldRect, type FillPlace } from "./fill";
import { pick, prompt, say } from "./prompts";

export type VaultMenuSection = { name: string | null; logins: VaultLogin[] };

export type VaultMenu = {
  id: number;
  plugin: string;
  title: string;
  origin: string;
  host: string;
  field: string | null;
  anchor: FieldRect | null;
  sections: VaultMenuSection[];
  all: VaultLogin[];
  locked: { account: string; name: string }[];
  unlocked: string[];
  names: Record<string, string>;
  generate: boolean;
};

const SELF = "\u0000self";
let serial = 0;

export const loginKey = (login: VaultLogin) => `${login.space.account}\u0000${login.id}`;

async function firstAccount(plugin: string, title: string, base: string, windowId: string): Promise<boolean> {
  const vault = currentVault(plugin);
  const choices: QuickPickItem[] = (vault?.capabilities.servers ?? []).map((s) => ({ id: s.id, title: s.name, ...(s.detail ? { subtitle: s.detail } : {}) }));
  if (vault?.capabilities.selfHosted) choices.push({ id: SELF, title: "Self-hosted…", subtitle: "Your own server" });
  const server = await pick(plugin, windowId, choices, `Sign in to ${title}`, "Where is your vault?");
  if (!server) return false;
  const address = server === SELF ? await prompt(windowId, "Self-hosted server", { message: "Enter your server's address.", placeholder: "https://vault.example" }) : server;
  if (!address) return false;
  const email = await prompt(windowId, `Sign in to ${title}`, { message: `Enter your ${title} email address.`, placeholder: "Email address" });
  if (!email) return false;
  return addAccount(plugin, title, base, address.trim(), email, windowId);
}

async function matchingKeys(views: readonly AccountView[], origin: string): Promise<Set<string>> {
  const lists = await Promise.all(
    views.map(async (v) => {
      const matched = await ask(v.space, "match", { origin });
      const ids = matched.ok && Array.isArray(matched.result.ids) ? (matched.result.ids as string[]) : [];
      return ids.map((id) => `${v.space.account}\u0000${id}`);
    }),
  );
  return new Set(lists.flat());
}

export async function buildVaultMenu(views: readonly AccountView[], place: { plugin: string; title: string; origin: string; field: string | null; anchor: FieldRect | null }): Promise<VaultMenu> {
  const wantsCode = place.field === "code";
  const unlocked = views.filter((v) => v.account.state === "unlocked");
  const names = views.length > 1 ? accountLabels(views) : null;
  const matched = await matchingKeys(unlocked, place.origin);
  const lists = await Promise.all(unlocked.map(async (v) => (await loadItems(v.space)).map((x) => indexLogin(x, v.space))));
  const usable = (x: VaultLogin) => !wantsCode || x.hasTotp;
  const all = lists.flat().filter(usable);
  const sections = unlocked
    .map((v, i) => ({ name: names?.get(v.space.account) ?? null, logins: (lists[i] ?? []).filter((x) => usable(x) && matched.has(loginKey(x))) }))
    .filter((s) => s.logins.length);
  return {
    id: ++serial,
    plugin: place.plugin,
    title: place.title,
    origin: place.origin,
    host: new URL(place.origin).host,
    field: place.field,
    anchor: place.anchor,
    sections,
    all,
    locked: views.filter((v) => v.account.state === "locked").map((v) => ({ account: v.space.account, name: names?.get(v.space.account) ?? v.account.email })),
    unlocked: unlocked.map((v) => v.space.account),
    names: Object.fromEntries(names ?? []),
    generate: !wantsCode,
  };
}

export async function openVaultFill(tabId: string, plugin: string, title: string, field: string | undefined): Promise<void> {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return;
  if (!currentVault(plugin)) return say(tab.windowId, `${title} isn't ready`, `Its helper: ${whyNotReady(plugin)}.`);
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  const { windowId, profileId } = tab;
  const base = vaultAccountOf(useBrowser.getState(), profileId);
  const anchor = await focusedFieldRect(tabId);
  let known = await spaceAccounts(plugin, title, base);
  if (!known) return say(windowId, `${title} didn't answer`, "Settings › Plugins has its log.");
  if (!known.views.length) {
    if (!(await firstAccount(plugin, title, base, windowId))) return;
    known = await spaceAccounts(plugin, title, base);
  } else {
    const locked = known.views.filter((v) => v.account.state === "locked").map((v) => v.space);
    const opened = await unlockWithTouchId(locked, title);
    const only = known.views.length === 1 ? known.views[0] : undefined;
    if (only && only.account.state === "locked" && !opened.length && !(await unlock(only.space, windowId))) return;
    if (locked.length) known = await spaceAccounts(plugin, title, base);
  }
  if (!known?.views.length) return;
  const menu = await buildVaultMenu(known.views, { plugin, title, origin, field: field ?? null, anchor });
  patchPage(tabId, { vaultMenu: menu });
}

export function closeVaultMenu(tabId: string) {
  if (pageOf(tabId).vaultMenu) patchPage(tabId, { vaultMenu: null });
}

function placeOf(tabId: string, menu: VaultMenu): FillPlace | null {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return null;
  return { title: menu.title, origin: menu.origin, host: menu.host, wantsCode: menu.field === "code", tabId, windowId: tab.windowId };
}

export async function vaultMenuFill(tabId: string, key: string): Promise<void> {
  const menu = pageOf(tabId).vaultMenu;
  if (!menu) return;
  closeVaultMenu(tabId);
  const place = placeOf(tabId, menu);
  const login = menu.all.find((x) => loginKey(x) === key);
  if (!place || !login) return;
  const matches = menu.sections.some((s) => s.logins.some((x) => loginKey(x) === key));
  return matches ? fillLogin(login, place) : fillElsewhere(login, place);
}

export async function vaultMenuUnlock(tabId: string, account: string): Promise<void> {
  const menu = pageOf(tabId).vaultMenu;
  const tab = useBrowser.getState().tabs[tabId];
  if (!menu || !tab) return;
  closeVaultMenu(tabId);
  if (await unlock({ plugin: menu.plugin, title: menu.title, account }, tab.windowId)) await openVaultFill(tabId, menu.plugin, menu.title, menu.field ?? undefined);
}

export async function vaultMenuGenerate(tabId: string): Promise<void> {
  const menu = pageOf(tabId).vaultMenu;
  if (!menu) return;
  closeVaultMenu(tabId);
  const place = placeOf(tabId, menu);
  if (place) await useStrongPassword(menu.plugin, place);
}

export async function vaultMenuLock(tabId: string): Promise<void> {
  const menu = pageOf(tabId).vaultMenu;
  if (!menu) return;
  closeVaultMenu(tabId);
  await Promise.all(menu.unlocked.map((account) => lock({ plugin: menu.plugin, title: menu.title, account })));
}

export function vaultMenuManage(tabId: string) {
  const tab = useBrowser.getState().tabs[tabId];
  closeVaultMenu(tabId);
  if (tab) openSettings("profiles", regularProfileId(tab.profileId), SETTINGS_DETAIL.passwords);
}
