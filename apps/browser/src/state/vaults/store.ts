import { create } from "zustand";
import { engineProfile, incognitoOriginal, isIncognitoProfile } from "../browser/model";
import type { BrowserState } from "../browser/store";
import { callVault, type VaultOutcome } from "../plugins/tools";
import { currentPlugins } from "../plugins/store";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";

const PROTOCOL = 1;
export const CALL_MS = 60_000;
const MAX_ACCOUNT = 64;

export type VaultState = "signedOut" | "locked" | "unlocked";
export type UnlockMode = "password" | "touchId" | "touchIdAfterQuit";
export type VaultUri = { uri: string; match: string | null };
export type VaultItem = {
  id: string;
  title: string;
  username: string;
  uris: VaultUri[];
  hasTotp: boolean;
  hasNotes: boolean;
  reprompt: boolean;
  organization: boolean;
  revision: string;
};
export type VaultServer = { id: string; name: string; detail?: string };
export type VaultCapabilities = { servers: VaultServer[]; selfHosted: boolean; generate: string[]; manage: boolean };

export type VaultAccount = {
  state: VaultState | null;
  email: string;
  server: string;
  unlock: UnlockMode;
  items: VaultItem[] | null;
};

type Vault = { run: number; capabilities: VaultCapabilities; accounts: Record<string, VaultAccount> };

export type Space = { plugin: string; account: string; title: string };
type SpaceKey = Pick<Space, "plugin" | "account">;

export const useVaults = create<{ vaults: Record<string, Vault> }>()(() => ({ vaults: {} }));

export type HostKey = { key: string; kind: "session" | "persistent" };
const hostKeys = new Map<string, HostKey>();
const prefsRead = new Set<string>();

const keyOf = (space: SpaceKey) => `${space.plugin}\u0000${space.account}`;

export const hostKeyOf = (space: SpaceKey) => hostKeys.get(keyOf(space)) ?? null;
export const keepKey = (space: SpaceKey, key: HostKey) => void hostKeys.set(keyOf(space), key);
export const dropKey = (space: SpaceKey) => void hostKeys.delete(keyOf(space));
export const prefsKnown = (space: SpaceKey) => prefsRead.has(keyOf(space));
export const notePrefs = (space: SpaceKey, read: boolean) => void (read ? prefsRead.add(keyOf(space)) : prefsRead.delete(keyOf(space)));

export const isState = (s: unknown): s is VaultState => s === "signedOut" || s === "locked" || s === "unlocked";

const blankAccount = (): VaultAccount => ({ state: null, email: "", server: "", unlock: "touchId", items: null });

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export function vaultAccountOf(s: Pick<BrowserState, "profiles">, profileId: string): string {
  const original = isIncognitoProfile(profileId) ? incognitoOriginal(profileId) : profileId;
  const name = engineProfile(s, original);
  if (!name) return "_";
  const encoded = [...new TextEncoder().encode(name)]
    .map((byte) => (/[A-Za-z0-9]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `_${byte.toString(16).padStart(2, "0")}`))
    .join("");
  return encoded.length <= MAX_ACCOUNT ? encoded : `${encoded.slice(0, MAX_ACCOUNT - 10)}__${fnv1a(name)}`;
}

export function slotOf(base: string, id: string): number | null {
  if (id === base) return 1;
  const rest = id.startsWith(`${base}-`) ? id.slice(base.length + 1) : "";
  return /^[1-9][0-9]{0,3}$/.test(rest) && Number(rest) >= 2 ? Number(rest) : null;
}

export function nextAccount(base: string, ids: readonly string[]): string {
  const used = new Set(ids.map((id) => slotOf(base, id)));
  for (let slot = 1; ; slot++) if (!used.has(slot)) return slot === 1 ? base : `${base}-${slot}`;
}

export function capabilitiesOf(raw: Record<string, unknown>): VaultCapabilities {
  const servers = Array.isArray(raw.servers)
    ? (raw.servers as Record<string, unknown>[]).flatMap((s) =>
        typeof s?.id === "string" && typeof s.name === "string" ? [{ id: s.id, name: s.name, ...(typeof s.detail === "string" ? { detail: s.detail } : {}) }] : [],
      )
    : [];
  const generate = Array.isArray(raw.generate) ? raw.generate.filter((g): g is string => typeof g === "string") : [];
  return { servers, selfHosted: raw.selfHosted === true, generate, manage: raw.reveal === true && raw.delete === true && raw.edit === true };
}

export function whyNotReady(plugin: string): string {
  const vault = useVaults.getState().vaults[plugin];
  const process = currentPlugins().processes[plugin];
  if (!process || process.state !== "running") return `its helper isn't running (${process?.state ?? "not started"}${process && "reason" in process && process.reason ? `: ${String(process.reason)}` : ""})`;
  if (!vault) return "its helper never said it was ready (vault.ready)";
  return `its helper restarted (run ${process.run}, ready on run ${vault.run})`;
}

export function currentVault(plugin: string): Vault | null {
  const vault = useVaults.getState().vaults[plugin];
  const process = currentPlugins().processes[plugin];
  if (!vault || process?.state !== "running" || process.run !== vault.run) return null;
  return vault;
}

export function patchAccount(space: SpaceKey, patch: Partial<VaultAccount> | null) {
  useVaults.setState((s) => {
    const vault = s.vaults[space.plugin];
    if (!vault) return s;
    const accounts = { ...vault.accounts };
    if (patch === null) delete accounts[space.account];
    else accounts[space.account] = { ...(accounts[space.account] ?? blankAccount()), ...patch };
    return { vaults: { ...s.vaults, [space.plugin]: { ...vault, accounts } } };
  });
}

export const accountOf = (space: SpaceKey): VaultAccount | null => currentVault(space.plugin)?.accounts[space.account] ?? null;

export function vaultMessage(plugin: string, run: number, method: string, params: Record<string, unknown>): Body | null {
  if (method === "vault.ready") {
    if (params.protocol !== PROTOCOL) return failure("refused", `Ardia speaks vault protocol ${PROTOCOL}, not ${String(params.protocol)}.`);
    const capabilities = (params.capabilities ?? {}) as Record<string, unknown>;
    if (capabilities.accounts !== true) return failure("refused", "Ardia keeps one account per profile: start the helper with --accounts.");
    for (const key of [...hostKeys.keys()]) if (key.startsWith(`${plugin}\u0000`)) hostKeys.delete(key);
    for (const key of [...prefsRead]) if (key.startsWith(`${plugin}\u0000`)) prefsRead.delete(key);
    useVaults.setState((s) => ({ vaults: { ...s.vaults, [plugin]: { run, capabilities: capabilitiesOf(capabilities), accounts: {} } } }));
    return null;
  }
  const vault = useVaults.getState().vaults[plugin];
  if (!vault || vault.run !== run) return failure("refused", "Send vault.ready first.");
  if (typeof params.account !== "string") return null;
  const space = { plugin, account: params.account };
  const data = (params.data ?? {}) as Record<string, unknown>;
  if (params.event === "state" && isState(data.state)) {
    if (data.state === "signedOut") {
      dropKey(space);
      patchAccount(space, { state: "signedOut", items: null });
    } else patchAccount(space, { state: data.state, ...(data.state === "locked" ? { items: null } : {}) });
  } else if (params.event === "changed") {
    const listed = accountOf(space)?.items;
    patchAccount(space, { items: null });
    if (listed && accountOf(space)?.state === "unlocked") void loadItems({ ...space, title: "" }, true);
  }
  return null;
}

export async function ask(space: Space, verb: string, input: Record<string, unknown> = {}, timeoutMs = CALL_MS): Promise<VaultOutcome> {
  if (!currentVault(space.plugin)) return { ok: false, code: "failed", message: `${space.title || space.plugin} isn't running.` };
  return callVault(space.plugin, verb, { ...input, account: space.account }, timeoutMs);
}

export function itemOf(x: Record<string, unknown>): VaultItem | null {
  if (typeof x.id !== "string") return null;
  const uris = Array.isArray(x.uris)
    ? (x.uris as Record<string, unknown>[]).flatMap((u) => (typeof u?.uri === "string" ? [{ uri: u.uri, match: typeof u.match === "string" ? u.match : null }] : []))
    : [];
  return {
    id: x.id,
    title: String(x.title ?? ""),
    username: String(x.username ?? ""),
    uris,
    hasTotp: x.hasTotp === true,
    hasNotes: x.hasNotes === true,
    reprompt: x.reprompt === true,
    organization: x.organization === true,
    revision: String(x.revision ?? ""),
  };
}

export async function loadItems(space: Space, fresh = false): Promise<VaultItem[]> {
  const cached = accountOf(space)?.items;
  if (cached && !fresh) return cached;
  const listed = await ask(space, "items");
  if (!listed.ok || !Array.isArray(listed.result.items)) return cached ?? [];
  const items = (listed.result.items as Record<string, unknown>[]).flatMap((x) => itemOf(x) ?? []).sort((a, b) => a.title.localeCompare(b.title));
  patchAccount(space, { items });
  return items;
}

export const vaultSnapshot = () =>
  Object.entries(useVaults.getState().vaults).flatMap(([plugin, v]) =>
    Object.entries(v.accounts).map(([account, a]) => ({
      plugin,
      account,
      state: a.state,
      unlock: a.unlock,
      items: a.items?.length ?? null,
      hostKey: hostKeyOf({ plugin, account })?.kind ?? null,
    })),
  );
