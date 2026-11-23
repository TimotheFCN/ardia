import { choose, confirm } from "../../platform/dialogs";
import { callVault } from "../plugins/tools";
import { accountOf, ask, CALL_MS, currentVault, isState, nextAccount, patchAccount, slotOf, whyNotReady, type Space, type VaultAccount } from "./store";
import { forgetPrefs, keepHostKey, unlockMode, wrapFor } from "./unlock";
import { prompt, say } from "./prompts";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

const SIGN_IN_MS = 120_000;

export type AccountView = { space: Space; account: VaultAccount };
export type SpaceAccounts = { listed: string[]; views: AccountView[] };

export async function status(space: Space): Promise<VaultAccount | null> {
  const answer = await ask(space, "status");
  if (!answer.ok || !isState(answer.result.state)) return null;
  await unlockMode(space);
  patchAccount(space, { state: answer.result.state, email: String(answer.result.account ?? ""), server: String(answer.result.server ?? "") });
  return accountOf(space);
}

async function listedAccounts(plugin: string, base: string): Promise<string[] | null> {
  const listed = await callVault(plugin, "accounts", {}, CALL_MS);
  if (!listed.ok || !Array.isArray(listed.result.accounts)) return null;
  return (listed.result.accounts as unknown[])
    .filter((id): id is string => typeof id === "string" && slotOf(base, id) !== null)
    .sort((a, b) => (slotOf(base, a) ?? 0) - (slotOf(base, b) ?? 0));
}

export async function spaceAccounts(plugin: string, title: string, base: string): Promise<SpaceAccounts | null> {
  if (!currentVault(plugin)) return null;
  const listed = await listedAccounts(plugin, base);
  if (!listed) return null;
  const views = await Promise.all(
    listed.map(async (account) => {
      const space = { plugin, title, account };
      const known = await status(space);
      return known && known.state !== "signedOut" ? { space, account: known } : null;
    }),
  );
  return { listed, views: views.filter((v): v is AccountView => v !== null) };
}

export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function accountLabels(views: readonly AccountView[]): Map<string, string> {
  const emails = views.map((v) => v.account.email.toLowerCase());
  return new Map(
    views.map((v) => {
      const twice = emails.filter((e) => e === v.account.email.toLowerCase()).length > 1;
      return [v.space.account, twice ? `${v.account.email} (${serverHost(v.account.server)})` : v.account.email || v.space.account];
    }),
  );
}

async function twoStepMethod(result: Record<string, unknown>, windowId?: string): Promise<string | null> {
  const methods = Array.isArray(result.methods) ? (result.methods as { id: string; name: string }[]) : [];
  if (methods.length === 1) return methods[0]?.id ?? null;
  const chosen = await choose({
    title: "Two-step login",
    message: "Where do you get your code?",
    choices: [...methods.map((m) => m.name), "Cancel"],
    cancelChoice: methods.length,
    ...(windowId ? { windowId } : {}),
  });
  return methods[chosen.choice]?.id ?? null;
}

async function signIn(space: Space, server: string, email: string, windowId?: string): Promise<boolean> {
  const { title } = space;
  const password = await prompt(windowId, `Sign in to ${title}`, { message: `Enter the master password for ${email}.`, password: true });
  if (!password) return false;
  const mode = await unlockMode(space);
  const wrap = wrapFor(mode);
  const fields: Record<string, unknown> = { server, email, password, ...(wrap ? { wrapKey: wrap } : {}) };
  for (let step = 0; step < 4; step++) {
    const answer = await ask(space, "signIn", fields, SIGN_IN_MS);
    if (!answer.ok) {
      say(windowId, `Couldn't sign in to ${title}`, answer.message);
      if (answer.code !== "wrong_code") return false;
      delete fields.code;
      continue;
    }
    const result = answer.result;
    if (result.state === "unlocked") {
      await keepHostKey(space, mode, result.hostKey);
      patchAccount(space, { state: "unlocked", email });
      return true;
    }
    if (result.needs === "newDeviceCode") {
      const code = await prompt(windowId, `Verify This ${PLATFORM_TERMS.computerTitle}`, { message: `Enter the code ${title} sent to ${email}.`, placeholder: "Code" });
      if (!code) return false;
      delete fields.method;
      fields.code = code.trim();
      continue;
    }
    if (result.needs !== "code") return false;
    const method = await twoStepMethod(result, windowId);
    if (!method) return false;
    fields.method = method;
    const methods = Array.isArray(result.methods) ? result.methods.length : 0;
    if (method === "1" && !fields.code && methods > 1) await ask(space, "signIn", fields, SIGN_IN_MS);
    const code = await prompt(windowId, "Two-step login", { message: method === "1" ? "Enter the code from the email." : "Enter your code.", placeholder: "Code" });
    if (!code) return false;
    fields.code = code.trim();
  }
  return false;
}

export async function addAccount(plugin: string, title: string, base: string, server: string, email: string, windowId?: string): Promise<boolean> {
  const known = await spaceAccounts(plugin, title, base);
  if (!known) {
    say(windowId, `${title} isn't ready`, `Its helper: ${whyNotReady(plugin)}.`);
    return false;
  }
  const typed = email.trim();
  if (known.views.some((v) => v.account.email.toLowerCase() === typed.toLowerCase() && serverHost(v.account.server) === serverHost(server))) {
    say(windowId, `${typed} is already signed in`, "It's already in this profile.");
    return false;
  }
  const space = { plugin, title, account: nextAccount(base, known.listed) };
  if (await signIn(space, server, typed, windowId)) {
    await status(space);
    return true;
  }
  if (!known.listed.includes(space.account)) await ask(space, "signOut");
  patchAccount(space, null);
  return false;
}

export async function signOut(space: Space, name: string, windowId?: string): Promise<boolean> {
  const answer = await confirm({
    title: `Sign out of ${name}?`,
    message: `Ardia removes this account from this ${PLATFORM_TERMS.computer}. Your logins stay in ${space.title}.`,
    confirmTitle: "Sign Out",
    destructive: true,
    ...(windowId ? { windowId, sheetOnly: true } : {}),
  });
  if (answer.confirmed !== true) return false;
  const done = await ask(space, "signOut");
  if (!done.ok) {
    say(windowId, `Couldn't sign out of ${name}`, done.message);
    return false;
  }
  await forgetPrefs(space);
  patchAccount(space, null);
  return true;
}
