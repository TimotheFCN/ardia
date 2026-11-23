import { asSecret, reveal, type Secret } from "@ardia/core";
import type { VaultLogin } from "../../platform/passwordProviders";
import { useBrowser } from "../browser/store";
import { usePlugins } from "../plugins/store";
import { patchPage, pageOf } from "../tabs/pageState";
import { managerPluginOf, managerPlugins, profilePasswordManager } from "../site/passwordManagerChoice";
import { ask, loadItems, vaultAccountOf, type Space, type VaultItem } from "./store";
import { accountLabels, spaceAccounts } from "./accounts";
import { unlock } from "./unlock";
import { saveLogin, updateLogin } from "./logins";
import { say } from "./prompts";

export type { VaultLogin };

export type VaultSaveOffer = {
  id: number;
  plugin: string;
  title: string;
  origin: string;
  username: string;
  update: { account: string; id: string; title: string } | null;
  accounts: { account: string; name: string }[];
};

type Pending = { password: Secret<"password">; item: VaultItem | null };

const pending = new Map<number, Pending>();
let serial = 0;

export function savableOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && local) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function vaultPluginOf(profileId: string) {
  const plugins = managerPlugins(usePlugins.getState());
  const plugin = managerPluginOf(plugins, profilePasswordManager(useBrowser.getState(), plugins, profileId));
  return plugin?.spec.fill === "tool" ? plugin : null;
}

async function existingLogin(space: Space, origin: string, username: string): Promise<VaultItem | null> {
  const matched = await ask(space, "match", { origin });
  if (!matched.ok || !Array.isArray(matched.result.ids)) return null;
  const ids = new Set(matched.result.ids as string[]);
  return (await loadItems(space)).find((x) => ids.has(x.id) && x.username.toLowerCase() === username.toLowerCase()) ?? null;
}

async function unchanged(space: Space, item: VaultItem, origin: string, password: string): Promise<boolean> {
  if (item.reprompt) return true;
  const stored = await ask(space, "fill", { id: item.id, origin, fields: ["password"] });
  return stored.ok && (stored.result.values as Record<string, string> | undefined)?.password === password;
}

export async function vaultLoginSubmitted(tabId: string, login: VaultLogin): Promise<void> {
  const tab = useBrowser.getState().tabs[tabId];
  const origin = tab ? savableOrigin(tab.url) : null;
  if (!tab || !origin || !login.password) return;
  const showing = pageOf(tabId).vaultSave;
  const held = showing ? pending.get(showing.id) : undefined;
  if (showing?.origin === origin && showing.username === login.username && held && reveal(held.password) === login.password) return;
  const plugin = vaultPluginOf(tab.profileId);
  if (!plugin) return;
  const known = await spaceAccounts(plugin.name, plugin.title, vaultAccountOf(useBrowser.getState(), tab.profileId));
  if (!known?.views.length) return;
  const names = accountLabels(known.views);
  let update: { space: Space; item: VaultItem } | null = null;
  for (const v of known.views.filter((x) => x.account.state === "unlocked")) {
    const item = await existingLogin(v.space, origin, login.username);
    if (!item) continue;
    if (await unchanged(v.space, item, origin, login.password)) return;
    update = { space: v.space, item };
    break;
  }
  const id = ++serial;
  if (showing) pending.delete(showing.id);
  pending.set(id, { password: asSecret("password", login.password), item: update?.item ?? null });
  const offer: VaultSaveOffer = {
    id,
    plugin: plugin.name,
    title: plugin.title,
    origin,
    username: login.username,
    update: update ? { account: update.space.account, id: update.item.id, title: update.item.title } : null,
    accounts: known.views.map((v) => ({ account: v.space.account, name: names.get(v.space.account) ?? v.account.email })),
  };
  patchPage(tabId, { vaultSave: offer });
}

export function dismissVaultSave(tabId: string) {
  const offer = pageOf(tabId).vaultSave;
  if (offer) pending.delete(offer.id);
  patchPage(tabId, { vaultSave: null });
}

export async function acceptVaultSave(tabId: string, choice: { account: string; username: string }): Promise<boolean> {
  const offer = pageOf(tabId).vaultSave;
  const held = offer ? pending.get(offer.id) : undefined;
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  if (!offer || !held) return false;
  const space = { plugin: offer.plugin, title: offer.title, account: offer.update?.account ?? choice.account };
  const known = await spaceAccounts(offer.plugin, offer.title, vaultAccountOf(useBrowser.getState(), useBrowser.getState().tabs[tabId]?.profileId ?? ""));
  const state = known?.views.find((v) => v.space.account === space.account)?.account.state;
  if (state !== "unlocked" && !(await unlock(space, windowId))) return false;
  const password = reveal(held.password);
  const answer = held.item
    ? await updateLogin(space, held.item, { password, ...(choice.username !== held.item.username ? { username: choice.username } : {}) })
    : await saveLogin(space, { title: new URL(offer.origin).host, username: choice.username, password, uris: [{ uri: offer.origin, match: null }], totp: "", notes: "" });
  if (!answer.ok) {
    say(windowId, `Couldn't save to ${offer.title}`, answer.message);
    return false;
  }
  pending.delete(offer.id);
  if (pageOf(tabId).vaultSave?.id === offer.id) patchPage(tabId, { vaultSave: null });
  say(windowId, held.item ? `Password updated in ${offer.title}` : `Saved to ${offer.title}`);
  return true;
}
