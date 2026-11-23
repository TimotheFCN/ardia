import { confirmDeviceOwner } from "../../platform/passwords";
import { confirm } from "../../platform/dialogs";
import { keychainDelete, keychainRead, keychainSet } from "../../platform/keychain";
import { accountOf, ask, dropKey, hostKeyOf, keepKey, notePrefs, patchAccount, prefsKnown, type Space, type UnlockMode } from "./store";
import { prompt, say } from "./prompts";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

type Prefs = { unlock: UnlockMode; hostKey: string | null };

const isMode = (m: unknown): m is UnlockMode => m === "password" || m === "touchId" || m === "touchIdAfterQuit";
const keychainAccount = (space: Space) => `ardia.vault.${space.plugin}.${space.account}`;

async function readPrefs(space: Space): Promise<Prefs> {
  const read = await keychainRead(keychainAccount(space)).catch(() => null);
  if (read?.status !== "ok") return { unlock: "touchId", hostKey: null };
  try {
    const parsed = JSON.parse(read.value) as Record<string, unknown>;
    return { unlock: isMode(parsed.unlock) ? parsed.unlock : "touchId", hostKey: typeof parsed.hostKey === "string" ? parsed.hostKey : null };
  } catch {
    return { unlock: "touchId", hostKey: null };
  }
}

const writePrefs = (space: Space, prefs: Prefs): Promise<boolean> =>
  prefs.unlock === "touchId" && !prefs.hostKey
    ? keychainDelete(keychainAccount(space)).catch(() => false)
    : keychainSet(keychainAccount(space), JSON.stringify(prefs.hostKey ? prefs : { unlock: prefs.unlock })).catch(() => false);

export async function forgetPrefs(space: Space) {
  dropKey(space);
  notePrefs(space, false);
  await keychainDelete(keychainAccount(space)).catch(() => false);
}

export async function unlockMode(space: Space): Promise<UnlockMode> {
  const known = accountOf(space);
  if (known && prefsKnown(space)) return known.unlock;
  const prefs = await readPrefs(space);
  notePrefs(space, true);
  if (prefs.unlock === "touchIdAfterQuit" && prefs.hostKey && !hostKeyOf(space)) keepKey(space, { key: prefs.hostKey, kind: "persistent" });
  patchAccount(space, { unlock: prefs.unlock });
  return prefs.unlock;
}

export const wrapFor = (mode: UnlockMode) => (mode === "password" ? null : mode === "touchId" ? "session" : "persistent");

export async function keepHostKey(space: Space, mode: UnlockMode, hostKey: unknown) {
  const kind = wrapFor(mode);
  if (typeof hostKey !== "string" || !kind) return;
  keepKey(space, { key: hostKey, kind });
  if (kind === "persistent") await writePrefs(space, { unlock: mode, hostKey });
}

async function dropHostKey(space: Space) {
  const held = hostKeyOf(space);
  dropKey(space);
  if (held?.kind === "persistent") await writePrefs(space, { unlock: accountOf(space)?.unlock ?? "touchId", hostKey: null });
}

const canUseTouchId = (space: Space) => accountOf(space)?.unlock !== "password" && !!hostKeyOf(space);

async function touchIdUnlock(spaces: readonly Space[], reason: string): Promise<Space[]> {
  const ready = spaces.filter(canUseTouchId);
  if (!ready.length || !(await confirmDeviceOwner(reason).catch(() => false))) return [];
  const opened = await Promise.all(
    ready.map(async (space) => {
      const answer = await ask(space, "unlock", { hostKey: hostKeyOf(space)?.key });
      if (answer.ok) {
        patchAccount(space, { state: "unlocked" });
        return space;
      }
      await dropHostKey(space);
      return null;
    }),
  );
  return opened.filter((s): s is Space => s !== null);
}

export async function unlockWithTouchId(spaces: readonly Space[], title: string): Promise<Space[]> {
  await Promise.all(spaces.map(unlockMode));
  return touchIdUnlock(spaces, `unlock ${title}`);
}

export async function unlock(space: Space, windowId?: string): Promise<boolean> {
  const mode = await unlockMode(space);
  if ((await touchIdUnlock([space], `unlock ${space.title}`)).length) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = await prompt(windowId, `Unlock ${space.title}`, {
      password: true,
      message: attempt ? "That master password isn't right. Try again." : `Enter the master password for ${accountOf(space)?.email || "your account"}.`,
    });
    if (!password) return false;
    const wrap = wrapFor(mode);
    const answer = await ask(space, "unlock", { password, ...(wrap ? { wrapKey: wrap } : {}) });
    if (answer.ok) {
      await keepHostKey(space, mode, answer.result.hostKey);
      patchAccount(space, { state: "unlocked" });
      return true;
    }
    if (answer.code !== "wrong_password") {
      say(windowId, `Couldn't unlock ${space.title}`, answer.message);
      return false;
    }
  }
  return false;
}

export async function lock(space: Space): Promise<void> {
  const answer = await ask(space, "lock");
  if (answer.ok) patchAccount(space, { state: "locked", items: null });
}

async function persistentKey(space: Space, windowId?: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = await prompt(windowId, "Confirm Master Password", {
      password: true,
      message: attempt ? "That master password isn't right. Try again." : `Enter the master password for ${accountOf(space)?.email || "your account"}.`,
    });
    if (!password) return false;
    const answer = await ask(space, "unlock", { password, wrapKey: "persistent" });
    if (answer.ok && typeof answer.result.hostKey === "string") {
      if (!(await writePrefs(space, { unlock: "touchIdAfterQuit", hostKey: answer.result.hostKey }))) {
        await ask(space, "forgetHostKey", { wrapKey: "persistent" });
        say(windowId, `Couldn't turn on ${PLATFORM_TERMS.quickUnlock}`, "Ardia couldn't save the key to the Keychain.");
        return false;
      }
      keepKey(space, { key: answer.result.hostKey, kind: "persistent" });
      patchAccount(space, { state: "unlocked" });
      return true;
    }
    if (!answer.ok && answer.code !== "wrong_password") {
      say(windowId, `Couldn't set up ${PLATFORM_TERMS.quickUnlock} for ${space.title}`, answer.message);
      return false;
    }
  }
  return false;
}

export async function setUnlockMode(space: Space, mode: UnlockMode, windowId?: string): Promise<boolean> {
  const current = await unlockMode(space);
  if (mode === current) return true;
  if (mode === "touchIdAfterQuit") {
    const agreed = await confirm({
      title: `Use ${PLATFORM_TERMS.quickUnlock} when Ardia starts?`,
      message: `Anyone who can use ${PLATFORM_TERMS.quickUnlock} on this ${PLATFORM_TERMS.computer} will be able to open ${space.title}.`,
      confirmTitle: "Turn On",
      ...(windowId ? { windowId } : {}),
    });
    if (agreed.confirmed !== true || !(await persistentKey(space, windowId))) return false;
    patchAccount(space, { unlock: mode });
    return true;
  }
  const forgotten = await ask(space, "forgetHostKey", mode === "password" ? {} : { wrapKey: "persistent" });
  if (!forgotten.ok) {
    say(windowId, `Couldn't change how ${space.title} unlocks`, forgotten.message);
    return false;
  }
  if (mode === "password" || hostKeyOf(space)?.kind === "persistent") dropKey(space);
  await writePrefs(space, { unlock: mode, hostKey: null });
  patchAccount(space, { unlock: mode });
  return true;
}
