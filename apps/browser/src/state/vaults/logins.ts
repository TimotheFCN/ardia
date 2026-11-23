import { confirmDeviceOwner } from "../../platform/passwords";
import { callVault, type VaultOutcome } from "../plugins/tools";
import { ask, CALL_MS, currentVault, loadItems, type Space, type VaultItem, type VaultUri } from "./store";
import { prompt, say } from "./prompts";

export type LoginFields = { title: string; username: string; password: string; uris: VaultUri[]; totp: string; notes: string };
export type LoginChanges = Partial<Omit<LoginFields, "totp" | "notes">> & { totp?: string | null; notes?: string | null };
export type LoginSecrets = { password?: string; totp?: string; notes?: string };

export async function revealLogin(space: Space, item: VaultItem, windowId?: string): Promise<LoginSecrets | null> {
  const input: Record<string, unknown> = { id: item.id, fields: ["password", "totp", "notes"] };
  if (item.reprompt) {
    const masterPassword = await prompt(windowId, `Show ${item.title}`, { message: "Enter your master password to see this login.", password: true });
    if (!masterPassword) return null;
    input.masterPassword = masterPassword;
  } else if (!(await confirmDeviceOwner(`show the password for ${item.title}`).catch(() => false))) return null;
  const answer = await ask(space, "reveal", input);
  if (!answer.ok) {
    say(windowId, `Couldn't show ${item.title}`, answer.message);
    return null;
  }
  return (answer.result.values ?? {}) as LoginSecrets;
}

export async function syncNow(space: Space): Promise<VaultOutcome> {
  const answer = await ask(space, "sync", {}, 2 * CALL_MS);
  if (answer.ok) await loadItems(space, true);
  return answer;
}

export async function saveLogin(space: Space, fields: LoginFields): Promise<VaultOutcome> {
  const answer = await ask(space, "save", {
    title: fields.title,
    username: fields.username,
    password: fields.password,
    uris: fields.uris,
    ...(fields.totp ? { totp: fields.totp } : {}),
    ...(fields.notes ? { notes: fields.notes } : {}),
  });
  if (answer.ok) await loadItems(space, true);
  return answer;
}

export async function updateLogin(space: Space, item: VaultItem, changes: LoginChanges): Promise<VaultOutcome> {
  if (!Object.keys(changes).length) return { ok: true, result: {} };
  const answer = await ask(space, "update", { id: item.id, revision: item.revision, ...changes });
  if (answer.ok) await loadItems(space, true);
  return answer;
}

export async function deleteLogin(space: Space, item: VaultItem): Promise<VaultOutcome> {
  const answer = await ask(space, "delete", { id: item.id, revision: item.revision });
  if (answer.ok) await loadItems(space, true);
  return answer;
}

export async function generatePassword(plugin: string, kind = "random"): Promise<string | null> {
  if (!currentVault(plugin)) return null;
  const answer = await callVault(plugin, "generate", { kind }, CALL_MS);
  return answer.ok && typeof answer.result.password === "string" ? answer.result.password : null;
}
