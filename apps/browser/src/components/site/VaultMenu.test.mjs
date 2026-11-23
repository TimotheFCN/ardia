import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../test-native/index.ts");
const { MenuBody, placement } = await import("./VaultMenu.tsx");
const { MenuRow, POPOVER_MARGIN } = await import("../ui/index.ts");
const { vaultMenu } = await import("./tokens.ts");

const space = (account) => ({ plugin: "vault", title: "Bitwarden", account });
const login = (id, account, title, username) => ({ id, title, username, uris: [], hasTotp: false, hasNotes: false, reprompt: false, organization: false, revision: "r", space: space(account), site: "https://supabase.com", hay: `${title}\\n${username}`.toLowerCase() });
const a = login("a", "me", "Supabase", "timothe@example.com");
const b = login("b", "work", "Supabase", "timothe@work.example");
const other = login("c", "me", "GitHub", "octo");
const menu = {
  id: 1,
  plugin: "vault",
  title: "Bitwarden",
  origin: "https://supabase.com",
  host: "supabase.com",
  field: "password",
  anchor: { x: 100, y: 200, width: 300, height: 40 },
  sections: [{ name: "me@example.com", logins: [a] }, { name: "me@work.example", logins: [b] }],
  all: [a, b, other],
  locked: [{ account: "old", name: "me@old.example" }],
  unlocked: ["me", "work"],
  names: { me: "me@example.com", work: "me@work.example", old: "me@old.example" },
  generate: true,
};

function menuRows(node, found = []) {
  if (Array.isArray(node)) node.forEach((n) => menuRows(n, found));
  else if (node && typeof node === "object" && "props" in node) {
    if (node.type === MenuRow) found.push(node.props);
    menuRows(node.props.children, found);
  }
  return found;
}

test("logins show their title and username on two lines, and actions come after them with an accent icon", () => {
  const rows = menuRows(mount(() => MenuBody({ tabId: "t1", menu })).value);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.title, r.detail]), [["Supabase", "timothe@example.com"], ["Supabase", "timothe@work.example"]]);
  assert.ok(rows.slice(0, 2).every((r) => r.leading && !r.icon), "logins lead with the site's icon");
  const actions = rows.slice(2);
  assert.deepEqual(actions.map((r) => r.title), ["Unlock me@old.example", "Use Strong Password"]);
  assert.ok(actions.every((r) => r.icon && r.iconColor), "actions use a symbol in the accent colour");
  assert.equal(rows[0].selected, true, "the first login is highlighted for Return");
});

test("the menu opens under the field, stays inside the page, and goes above the field when there's no room below", () => {
  const area = { width: 1000, height: 800 };
  assert.deepEqual(placement(menu, 1, area, 300), { left: 100, top: 240 + vaultMenu.gap });
  assert.equal(placement(menu, 2, area, 300).left, 200, "page zoom scales the field's position");
  assert.equal(placement({ anchor: { x: 900, y: 200, width: 80, height: 40 } }, 1, area, 300).left, area.width - vaultMenu.width - POPOVER_MARGIN);
  assert.equal(placement({ anchor: { x: 100, y: 700, width: 300, height: 40 } }, 1, area, 300).top, 700 - vaultMenu.gap - 300);
  assert.deepEqual(placement({ anchor: null }, 1, area, 300), { top: POPOVER_MARGIN, right: POPOVER_MARGIN }, "from the menu bar, at the top right");
});
