import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../test-native/index.ts");
const { PluginQuickPick, pickSpan, pickBand } = await import("./PluginQuickPick.tsx");
const { OVERLAY, SURFACE } = await import("./tokens.ts");

function rows(node, found = []) {
  if (Array.isArray(node)) node.forEach((n) => rows(n, found));
  else if (node && typeof node === "object" && "props" in node) {
    if (node.props.item?.id) found.push({ id: node.props.item.id, highlighted: node.props.highlighted });
    rows(node.props.children, found);
  }
  return found;
}

function searchIn(node) {
  if (Array.isArray(node)) return node.map(searchIn).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  if (typeof node.props.onChangeText === "function" && typeof node.props.onArrow === "function") return node.props;
  return searchIn(node.props.children);
}

const items = Array.from({ length: 1500 }, (_, i) => ({ id: `login${i}`, title: `Site ${i}`, subtitle: `user${i}` }));
const request = { id: "qp1", plugin: "vault", windowId: "w1", items, options: { title: "Other Logins" } };
const SPAN = pickSpan(OVERLAY.quickPickHeight);

test("a long quick pick only builds the rows around what's on screen, and a search still looks through every item", () => {
  assert.ok(SPAN < 60, `a window of ${SPAN} rows`);
  const pick = mount(() => PluginQuickPick({ request }));
  assert.equal(rows(pick.value).length, SPAN);
  searchIn(pick.value).onChangeText("Site 1499");
  assert.deepEqual(rows(pick.value).map((r) => r.id), ["login1499"], "the last item is found");
  searchIn(pick.value).onChangeText("");
  assert.equal(rows(pick.value).length, SPAN);
});

test("the arrows wrap through every item, and the highlighted one is always built", () => {
  const pick = mount(() => PluginQuickPick({ request }));
  searchIn(pick.value).onArrow(-1);
  const built = rows(pick.value);
  assert.ok(built.length <= SPAN);
  assert.deepEqual(built.filter((r) => r.highlighted).map((r) => r.id), ["login1499"], "up from the first item reaches the last");
  searchIn(pick.value).onArrow(1);
  assert.deepEqual(rows(pick.value).filter((r) => r.highlighted).map((r) => r.id), ["login0"]);
});

test("the window moves in steps of a few rows, so scrolling renders again only now and then", () => {
  const viewport = OVERLAY.quickPickHeight;
  assert.equal(pickBand(0, viewport), 0);
  assert.equal(pickBand(SURFACE.itemHeight, viewport), 0, "a row of scrolling keeps the same window");
  assert.ok(pickBand(500 * SURFACE.itemHeight, viewport) <= 500, "the window starts above what's on screen");
  assert.ok(pickBand(500 * SURFACE.itemHeight, viewport) + SPAN > 500 + Math.ceil(viewport / SURFACE.itemHeight), "and reaches below it");
});
