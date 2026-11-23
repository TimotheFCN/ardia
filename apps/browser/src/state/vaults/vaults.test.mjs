import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const keychain = new Map();
const keychainWrites = [];
const dialogs = { confirms: [], prompts: [], confirmAnswer: false, promptAnswers: [] };
globalThis.acTestNativeModules = {
  ArdiaKeychain: {
    get: async (account) => keychain.get(account) ?? null,
    read: async (account) => (keychain.has(account) ? { status: "ok", value: keychain.get(account) } : { status: "missing" }),
    set: async (account, value) => (keychainWrites.push({ account, value }), keychain.set(account, value), true),
    delete: async (account) => (keychainWrites.push({ account, value: null }), keychain.delete(account), true),
  },
  ArdiaDialogs: {
    ...stub.shellNativeModules.ArdiaDialogs,
    confirm: async (options) => (dialogs.confirms.push(options), { confirmed: dialogs.confirmAnswer, suppressed: false }),
    prompt: async (options) => (dialogs.prompts.push(options), dialogs.promptAnswers.shift() ?? null),
  },
};
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const { usePlugins } = await import("../plugins/store.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { callVault } = await import("../plugins/tools.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { fieldProviderSet } = await import("../site/passwordManagerChoice.ts");
const { vaultSnapshot, vaultAccountOf, slotOf, nextAccount, capabilitiesOf, accountOf, useVaults } = await import("./store.ts");
const { useSpaceAccounts } = await import("./hooks.ts");
const { mount } = await import("../../test-hooks.mjs");
const { indexLogin, searchLogins, siteOf } = await import("./search.ts");
const { vaultLoginSubmitted, acceptVaultSave, dismissVaultSave } = await import("./save.ts");
const { newPasswordScript, fieldRectScript } = await import("./fill.ts");
const { buildVaultMenu } = await import("./menu.ts");
const { pageOf } = await import("../tabs/pageState.ts");
const { setUnlockMode, unlock } = await import("./unlock.ts");
const { fillScript } = await import("./fill.ts");
const { deliverPageEvent } = await import("../../../../../packages/ardiacore/src/pageEvents.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const VAULT = JSON.stringify({
  manifest: 2,
  name: "vault",
  title: "Vault",
  description: "A password manager with its own vault.",
  version: "1.0.0",
  requires: "0.0.0",
  sidecar: { run: ["bin/helper"] },
  permissions: { network: "*" },
  contributes: { passwordManager: { fill: "tool", fields: ["login", "oneTimeCode"] } },
});
const SYSTEM = JSON.stringify({
  manifest: 2,
  name: "panel",
  title: "Panel",
  version: "1.0.0",
  requires: "0.0.0",
  sidecar: { run: ["bin/helper"] },
  contributes: { passwordManager: { fill: "system", fields: ["login"] } },
});

async function enabled() {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  for (const key of ["starts", "stops", "replies", "events", "removed"]) host[key].length = 0;
  host.folders = [
    { name: "vault", status: "ok", text: VAULT },
    { name: "panel", status: "ok", text: SYSTEM },
  ];
  await lifecycle.rescanPlugins(consentToken());
  for (const name of ["vault", "panel"]) {
    assert.ok(lifecycle.requestPluginConsent(name), name);
    assert.ok(lifecycle.enablePlugin(name, P().consent.hash), name);
  }
  await settle();
  return { vault: P().processes.vault.run, panel: P().processes.panel.run };
}

let nextId = 0;
async function fromHelper(name, run, line) {
  const before = host.replies.length;
  stub.emitPluginLine({ name, run, line: JSON.stringify(line) });
  await settle();
  return host.replies.slice(before).map((r) => JSON.parse(r.line));
}

async function helperAsks(name, run, method, params) {
  const id = ++nextId;
  const lines = await fromHelper(name, run, { id, method, params });
  return lines.find((l) => l.id === id);
}

function lastCall() {
  const calls = host.events.map((r) => JSON.parse(r.line)).filter((l) => l.kind === "vault");
  return calls[calls.length - 1];
}

test("only a manager with its own vault and one account per profile may announce one, in the protocol Ardia speaks", async () => {
  const runs = await enabled();
  const capabilities = { accounts: true };
  assert.equal((await helperAsks("panel", runs.panel, "vault.ready", { protocol: 1, capabilities })).error.code, "refused");
  assert.equal((await helperAsks("vault", runs.vault, "vault.ready", { protocol: 2, capabilities })).error.code, "refused");
  assert.equal((await helperAsks("vault", runs.vault, "vault.ready", { protocol: 1, capabilities: { accounts: false } })).error.code, "refused");
  assert.deepEqual((await helperAsks("vault", runs.vault, "vault.ready", { protocol: 1, provider: "bitwarden", capabilities })).result, { ok: true });
  assert.deepEqual((await helperAsks("vault", runs.vault, "vault.event", { event: "state", account: "work", data: { state: "locked" } })).result, { ok: true });
  assert.deepEqual(
    vaultSnapshot().filter((v) => v.plugin === "vault"),
    [{ plugin: "vault", account: "work", state: "locked", unlock: "touchId", items: null, hostKey: null }],
    "an event belongs to its account only",
  );
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("a vault call comes from Ardia itself, and a verb's error keeps its code", async () => {
  const runs = await enabled();
  const listing = callVault("vault", "items", {}, 5000);
  await settle();
  const call = lastCall();
  assert.equal(call.name, "items");
  assert.deepEqual(call.caller, { kind: "host" }, "never the ardia command or another plugin");
  await fromHelper("vault", runs.vault, { id: ++nextId, method: "result", params: { call: call.call, result: { items: [{ id: "a", title: "GitHub" }] } } });
  const listed = await listing;
  assert.equal(listed.ok, true);
  assert.equal(listed.result.items[0].title, "GitHub");

  const filling = callVault("vault", "fill", { id: "a", origin: "https://github.com", fields: ["password"] }, 5000);
  await settle();
  await fromHelper("vault", runs.vault, { id: ++nextId, method: "result", params: { call: lastCall().call, result: { error: { code: "locked", message: "The vault is locked." } } } });
  assert.deepEqual(await filling, { ok: false, code: "locked", message: "The vault is locked." });

  assert.equal((await callVault("panel", "items", {}, 5000)).code, "refused", "a system-panel manager gets no vault calls");
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("a profile on a vault manager gets the key in host mode, without the system code setup", () => {
  S().hydrate({ profiles: { default: { id: "default", name: "P", color: "plum", icon: null, createdAt: 0, passwordManager: "plugin:vault" } }, profileOrder: ["default"] });
  const spec = { fill: "tool", fields: ["login", "oneTimeCode"], verificationCodeSetup: null, passkeys: null };
  const { providers } = fieldProviderSet(S(), [{ name: "vault", title: "Vault", spec, builtIn: false, approval: "x" }]);
  assert.equal(providers.length, 1);
  assert.deepEqual({ ...providers[0], profile: undefined }, { profile: undefined, fields: ["login", "oneTimeCode"], codeSetup: false, fill: "host" });
});

test("the fill script carries any value as data and checks the page is still on the origin", () => {
  const values = { username: 'o"ct`o${1}', password: "a b</script>\\" };
  const script = fillScript("https://github.com", values);
  assert.doesNotThrow(() => new Function("post", script), "it parses whatever the values hold");
  assert.ok(script.includes(JSON.stringify(values)));
  assert.ok(script.includes('if (location.origin !== origin) return "navigated";'));
  assert.ok(script.startsWith('post("result"'), "it answers through evaluate's post");
});

test("a host click and its field reach JS through the page event decoder; a field is kept only for a host click", () => {
  const seen = [];
  const props = { onFieldProviderOpened: (opened) => seen.push(opened) };
  deliverPageEvent(props, { name: "fieldProviderOpened", data: { via: "badge", shown: false, reason: "host", field: "password" } });
  deliverPageEvent(props, { name: "fieldProviderOpened", data: { via: "badge", shown: false, reason: "host", field: "secret" } });
  deliverPageEvent(props, { name: "fieldProviderOpened", data: { via: "badge", shown: false, reason: "notFocused", field: "password" } });
  assert.deepEqual(seen, [
    { via: "badge", shown: false, reason: "host", field: "password" },
    { via: "badge", shown: false, reason: "host" },
    { via: "badge", shown: false, reason: "notFocused" },
  ]);
});

test("each profile has its own account, private windows share their profile's, and ids are safe folder names", () => {
  S().hydrate({
    profiles: {
      default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
      work: { id: "work", name: "Work", color: "plum", icon: null, createdAt: 0, dataId: "Profile 1" },
      long: { id: "long", name: "L", color: "plum", icon: null, createdAt: 0, dataId: "x".repeat(80) },
      odd: { id: "odd", name: "O", color: "plum", icon: null, createdAt: 0, dataId: "Café_1" },
    },
    profileOrder: ["default", "work", "long", "odd"],
  });
  const valid = /^[A-Za-z0-9_-]{1,64}$/;
  const ids = ["default", "work", "long", "odd"].map((id) => vaultAccountOf(S(), id));
  for (const id of ids) assert.match(id, valid);
  assert.equal(new Set(ids).size, ids.length, "no two profiles share an account");
  assert.equal(vaultAccountOf(S(), "work"), "Profile_201");
  assert.equal(vaultAccountOf(S(), "odd"), "Caf_c3_a9_5f1", "an underscore is escaped too, so no two names meet");
  assert.equal(vaultAccountOf(S(), "incognito:w1@work"), vaultAccountOf(S(), "work"), "a private window uses its profile's account");
});

test("a space's accounts are its own id and numbered ones after it, and a new one takes the first free number", () => {
  assert.equal(slotOf("Work", "Work"), 1);
  assert.equal(slotOf("Work", "Work-2"), 2);
  assert.equal(slotOf("Work", "Work-12"), 12);
  for (const other of ["Work-1", "Work-02", "Work-x", "Workshop", "_", "Work-2-3"]) assert.equal(slotOf("Work", other), null, other);
  assert.equal(nextAccount("Work", []), "Work");
  assert.equal(nextAccount("Work", ["Work"]), "Work-2");
  assert.equal(nextAccount("Work", ["Work", "Work-2", "Work-4"]), "Work-3");
  assert.equal(nextAccount("Work", ["Work-2"]), "Work", "a space whose first account signed out gets its id back");
  S().hydrate({ profiles: { dash: { id: "dash", name: "D", color: "plum", icon: null, createdAt: 0, dataId: "Work-2" } }, profileOrder: ["dash"] });
  assert.equal(vaultAccountOf(S(), "dash"), "Work_2d2", "a - in a profile's name is escaped, so it never reads as an account number");
});

test("a manager's ready message names its servers and says whether Ardia can manage its logins", () => {
  assert.deepEqual(
    capabilitiesOf({
      servers: [{ id: "bitwarden.eu", name: "bitwarden.eu", detail: "EU cloud" }, { id: 3 }, "us"],
      selfHosted: true,
      generate: ["random", 4],
      edit: true,
      reveal: true,
      delete: true,
    }),
    { servers: [{ id: "bitwarden.eu", name: "bitwarden.eu", detail: "EU cloud" }], selfHosted: true, generate: ["random"], manage: true },
  );
  assert.equal(capabilitiesOf({ edit: true, reveal: true }).manage, false, "a manager that can't delete gets no edit sheets");
});

function answering(run, handler) {
  const answered = new Set(host.events.map((r) => JSON.parse(r.line)).filter((l) => l.kind === "vault").map((l) => l.call));
  const calls = [];
  let done = false;
  const loop = (async () => {
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const r of host.events) {
        const l = JSON.parse(r.line);
        if (l.kind !== "vault" || answered.has(l.call)) continue;
        answered.add(l.call);
        calls.push({ verb: l.name, input: l.input });
        stub.emitPluginLine({ name: "vault", run, line: JSON.stringify({ id: ++nextId, method: "result", params: { call: l.call, result: handler(l.name, l.input) } }) });
      }
    }
  })();
  return { calls, stop: () => ((done = true), loop) };
}

async function readyVault() {
  const runs = await enabled();
  const capabilities = { accounts: true, edit: true, reveal: true, delete: true };
  assert.deepEqual((await helperAsks("vault", runs.vault, "vault.ready", { protocol: 1, capabilities })).result, { ok: true });
  keychain.clear();
  keychainWrites.length = 0;
  dialogs.confirms.length = 0;
  dialogs.prompts.length = 0;
  stub.passwordProviders.calls.length = 0;
  stub.passwordProviders.ownerConfirmed = true;
  return runs;
}

const WORK = { plugin: "vault", account: "work", title: "Vault" };
const KEY = "ardia.vault.vault.work";

test("Touch ID after quitting asks first, takes the master password, and keeps its key in Ardia's own Keychain entry", async () => {
  const runs = await readyVault();
  const helper = answering(runs.vault, (verb, input) => (verb === "unlock" && input.password === "right" ? { state: "unlocked", hostKey: "persistent-key" } : verb === "unlock" ? { error: { code: "wrong_password", message: "no" } } : { ok: true }));

  dialogs.confirmAnswer = false;
  assert.equal(await setUnlockMode(WORK, "touchIdAfterQuit"), false);
  assert.equal(dialogs.confirms.length, 1, "it says what the choice costs first");
  assert.equal(dialogs.prompts.length, 0, "and goes no further when the person declines");

  dialogs.confirmAnswer = true;
  dialogs.promptAnswers = ["wrong", "right"];
  assert.equal(await setUnlockMode(WORK, "touchIdAfterQuit"), true);
  assert.ok(dialogs.prompts.every((p) => p.secure === true), "the master password goes in a secure field");
  assert.deepEqual(helper.calls.filter((c) => c.verb === "unlock").map((c) => c.input.wrapKey), ["persistent", "persistent"]);
  assert.deepEqual(JSON.parse(keychain.get(KEY)), { unlock: "touchIdAfterQuit", hostKey: "persistent-key" });
  assert.equal(accountOf(WORK).unlock, "touchIdAfterQuit");
  assert.ok(!KEY.startsWith("ardia.plugin."), "the plugin's own secrets can't reach it");
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("after a restart Touch ID unlocks with the kept key, and a key that no longer opens the vault is dropped for the master password", async () => {
  const runs = await readyVault();
  keychain.set(KEY, JSON.stringify({ unlock: "touchIdAfterQuit", hostKey: "persistent-key" }));
  let keyWorks = true;
  const helper = answering(runs.vault, (verb, input) => {
    if (verb === "unlock" && input.hostKey) return keyWorks ? { state: "unlocked" } : { error: { code: "wrong_password", message: "stale" } };
    if (verb === "unlock") return { state: "unlocked", hostKey: "new-key" };
    return { ok: true };
  });

  assert.equal(await unlock(WORK), true);
  assert.deepEqual(stub.passwordProviders.calls.filter(([name]) => name === "confirmOwner").length, 1, "Touch ID first");
  assert.equal(helper.calls.find((c) => c.verb === "unlock").input.hostKey, "persistent-key");
  assert.equal(dialogs.prompts.length, 0, "no master password");

  keyWorks = false;
  dialogs.promptAnswers = ["right"];
  assert.equal(await unlock(WORK), true);
  assert.equal(dialogs.prompts.length, 1, "the master password once the key is stale");
  assert.equal(helper.calls.at(-1).input.wrapKey, "persistent", "and a new key replaces it");
  assert.deepEqual(JSON.parse(keychain.get(KEY)), { unlock: "touchIdAfterQuit", hostKey: "new-key" });
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("with the master password chosen, Touch ID is never offered and the helper forgets every key", async () => {
  const runs = await readyVault();
  const helper = answering(runs.vault, (verb) => (verb === "unlock" ? { state: "unlocked", hostKey: "should-not-come" } : { ok: true }));
  dialogs.promptAnswers = ["right"];
  assert.equal(await unlock(WORK), true, "Touch ID by default, so the first unlock keeps a session key");
  assert.equal(helper.calls.at(-1).input.wrapKey, "session");

  assert.equal(await setUnlockMode(WORK, "password"), true);
  assert.deepEqual(helper.calls.at(-1), { verb: "forgetHostKey", input: { account: "work" } }, "both kinds of key");
  assert.deepEqual(JSON.parse(keychain.get(KEY)), { unlock: "password" });

  stub.passwordProviders.calls.length = 0;
  dialogs.promptAnswers = ["right"];
  assert.equal(await unlock(WORK), true);
  assert.equal(stub.passwordProviders.calls.filter(([name]) => name === "confirmOwner").length, 0, "no Touch ID");
  assert.equal(helper.calls.at(-1).input.wrapKey, undefined, "and no key to keep");
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("the Passwords page reads a snapshot that stays the same until its accounts change, so it never renders in a loop", () => {
  const account = (state) => ({ state, email: "me@example.com", server: "https://vault.example.com", unlock: "touchId", items: null });
  useVaults.setState({ vaults: { vault: { run: 99, capabilities: capabilitiesOf({}), accounts: { work: account("locked"), "work-2": account("signedOut"), home: account("locked") } } } });
  const page = mount(() => useSpaceAccounts("vault", "Vault", "work"));
  assert.deepEqual(page.value.views.map((v) => v.space.account), ["work"], "the space's signed-in accounts only");
  const before = page.renders;
  useVaults.setState((s) => ({ vaults: { ...s.vaults, other: { run: 1, capabilities: capabilitiesOf({}), accounts: {} } } }));
  assert.equal(page.renders, before, "another manager's change doesn't render it again");
  useVaults.setState((s) => ({ vaults: { ...s.vaults, vault: { ...s.vaults.vault, accounts: { ...s.vaults.vault.accounts, work: account("unlocked") } } } }));
  assert.equal(page.value.views[0].account.state, "unlocked", "its own account's change does");
  useVaults.setState({ vaults: {} });
});

test("logins are indexed once: every word of a search must appear, and the icon comes from the first web address", () => {
  const space = { plugin: "vault", account: "work", title: "Vault" };
  const item = (id, title, username, ...uris) => ({ id, title, username, uris: uris.map((uri) => ({ uri, match: null })), hasTotp: false, hasNotes: false, reprompt: false, organization: false, revision: "r" });
  const logins = [
    indexLogin(item("a", "GitHub", "octo", "androidapp://com.github", "github.com/login"), space),
    indexLogin(item("b", "GitLab", "me@work.example", "https://gitlab.example"), space),
  ];
  assert.equal(logins[0].site, "https://github.com", "a bare host is a web address, an app link isn't");
  assert.deepEqual(searchLogins(logins, "git").map((x) => x.id), ["a", "b"]);
  assert.deepEqual(searchLogins(logins, "GIT  work").map((x) => x.id), ["b"], "every word, in any field, any case");
  assert.equal(searchLogins(logins, ""), logins, "no search, no copy");
  assert.equal(siteOf("javascript:alert(1)"), null);
});

async function vaultTab(url) {
  const runs = await readyVault();
  S().hydrate({ profiles: { default: { id: "default", name: "P", color: "plum", icon: null, createdAt: 0, passwordManager: "plugin:vault" } }, profileOrder: ["default"] });
  S().createWindow({ url });
  const tabId = Object.keys(S().tabs).find((id) => S().tabs[id].url === url);
  return { runs, tabId, base: vaultAccountOf(S(), "default") };
}

function vaultWith(base, stored) {
  return (verb, input) => {
    if (verb === "accounts") return { accounts: [base] };
    if (verb === "status") return { state: "unlocked", account: "me@example.com", server: "https://vault.example" };
    if (verb === "items") return { items: [{ id: "a", title: "GitHub", username: "octo", uris: [{ uri: "https://github.com", match: null }], revision: "r1" }] };
    if (verb === "match") return { ids: input.origin === "https://github.com" ? ["a"] : [] };
    if (verb === "fill") return { values: { password: stored } };
    if (verb === "save" || verb === "update") return { item: { id: "a", title: "GitHub", username: input.username ?? "octo", uris: [], revision: "r2" } };
    return { ok: true };
  };
}

test("a submitted login that isn't in the vault offers to save it for the page's origin, with the password kept out of the page store", async () => {
  const { runs, tabId, base } = await vaultTab("https://github.com/signup");
  const helper = answering(runs.vault, vaultWith(base, "old"));
  await vaultLoginSubmitted(tabId, { username: "new@example.com", password: "pw1", main: true });
  const offer = pageOf(tabId).vaultSave;
  assert.equal(offer?.update, null);
  assert.equal(offer.origin, "https://github.com");
  assert.ok(!JSON.stringify(offer).includes("pw1"), "the offer shown in the page store has no password");
  assert.equal(await acceptVaultSave(tabId, { account: base, username: "new@example.com" }), true);
  const saved = helper.calls.find((c) => c.verb === "save").input;
  assert.deepEqual({ ...saved, account: undefined }, { account: undefined, title: "github.com", username: "new@example.com", password: "pw1", uris: [{ uri: "https://github.com", match: null }] });
  assert.equal(pageOf(tabId).vaultSave, null);
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("a login the vault already has with the same password offers nothing; a new password offers to update that login", async () => {
  const { runs, tabId, base } = await vaultTab("https://github.com/login");
  const helper = answering(runs.vault, vaultWith(base, "same"));
  await vaultLoginSubmitted(tabId, { username: "octo", password: "same", main: true });
  assert.equal(pageOf(tabId).vaultSave, null);
  await vaultLoginSubmitted(tabId, { username: "Octo", password: "changed", main: true });
  assert.deepEqual(pageOf(tabId).vaultSave?.update, { account: base, id: "a", title: "GitHub" }, "usernames match without case");
  assert.equal(await acceptVaultSave(tabId, { account: base, username: "Octo" }), true);
  const update = helper.calls.find((c) => c.verb === "update").input;
  assert.equal(update.id, "a");
  assert.equal(update.revision, "r1");
  assert.equal(update.password, "changed");
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("Not Now forgets the offer, and a page that isn't https gets none", async () => {
  const { runs, tabId, base } = await vaultTab("http://example.org/login");
  const helper = answering(runs.vault, vaultWith(base, "old"));
  await vaultLoginSubmitted(tabId, { username: "me", password: "pw", main: true });
  assert.equal(pageOf(tabId).vaultSave, null);
  S().createWindow({ url: "https://example.org/login" });
  const secure = Object.keys(S().tabs).find((id) => S().tabs[id].url === "https://example.org/login");
  await vaultLoginSubmitted(secure, { username: "me", password: "pw", main: true });
  assert.ok(pageOf(secure).vaultSave);
  dismissVaultSave(secure);
  assert.equal(pageOf(secure).vaultSave, null);
  assert.equal(await acceptVaultSave(secure, { account: base, username: "me" }), false, "nothing left to save");
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("Use Strong Password fills the clicked field and the empty confirmations after it, never a current password", () => {
  const script = newPasswordScript("https://github.com", 'p"w');
  assert.doesNotThrow(() => new Function("post", script));
  assert.ok(script.includes('if (location.origin !== origin) return { filled: 0 };'));
  assert.ok(script.includes("i === at || (i > at && !el.value)"), "from a password field: it and the empty ones after it");
  assert.ok(script.includes("passwords.length <= 2 ? empty : []"), "from elsewhere: the empty password fields of a sign-up, never a change-of-password form's");
});

test("a submitted login reaches JS through the page event decoder, and a password past the limit arrives empty, so nothing is offered", () => {
  const seen = [];
  const props = { onVaultLogin: (login) => seen.push(login) };
  deliverPageEvent(props, { name: "vaultLogin", data: { username: "me", password: "pw", main: true } });
  deliverPageEvent(props, { name: "vaultLogin", data: { username: 4, password: "x".repeat(1025) } });
  assert.deepEqual(seen, [
    { username: "me", password: "pw", main: true },
    { username: "", password: "", main: false },
  ]);
});

test("the key's menu groups the site's logins by account, keeps every login for search, and offers a new password outside code fields", async () => {
  const runs = await readyVault();
  const items = {
    work: [{ id: "a", title: "GitHub", username: "octo", uris: [{ uri: "https://github.com", match: null }], hasTotp: true, revision: "r" }, { id: "b", title: "Mail", username: "me", uris: [], revision: "r" }],
    home: [{ id: "c", title: "GitHub", username: "me", uris: [{ uri: "github.com", match: null }], revision: "r" }],
  };
  const helper = answering(runs.vault, (verb, input) => {
    if (verb === "items") return { items: items[input.account] };
    if (verb === "match") return { ids: items[input.account].filter((x) => x.uris.length).map((x) => x.id) };
    return { ok: true };
  });
  const account = (state, email) => ({ state, email, server: "https://vault.example", unlock: "touchId", items: null });
  const views = [
    { space: { plugin: "vault", title: "Vault", account: "work" }, account: account("unlocked", "me@work.example") },
    { space: { plugin: "vault", title: "Vault", account: "home" }, account: account("unlocked", "me@home.example") },
    { space: { plugin: "vault", title: "Vault", account: "old" }, account: account("locked", "me@old.example") },
  ];
  const place = { plugin: "vault", title: "Vault", origin: "https://github.com", field: "password", anchor: null };
  const menu = await buildVaultMenu(views, place);
  assert.deepEqual(menu.sections.map((s) => [s.name, s.logins.map((x) => x.id)]), [["me@work.example", ["a"]], ["me@home.example", ["c"]]]);
  assert.deepEqual(menu.all.map((x) => x.id).sort(), ["a", "b", "c"], "search reaches logins saved for other sites");
  assert.deepEqual(menu.locked, [{ account: "old", name: "me@old.example" }]);
  assert.deepEqual(menu.unlocked, ["work", "home"]);
  assert.equal(menu.generate, true);
  const codes = await buildVaultMenu(views, { ...place, field: "code" });
  assert.deepEqual(codes.all.map((x) => x.id), ["a"], "a code field only lists logins with a code");
  assert.equal(codes.generate, false);
  await helper.stop();
  lifecycle.disablePlugin("vault");
  lifecycle.disablePlugin("panel");
});

test("the menu's anchor is the focused field's rectangle, read from the page as four numbers", () => {
  const script = fieldRectScript();
  assert.doesNotThrow(() => new Function("post", script));
  assert.ok(script.includes("getBoundingClientRect"));
});
