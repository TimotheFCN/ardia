import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../test-native/index.ts");
const { firstRowOf, rowSpan } = await import("./settingsScroll.ts");
const { WindowedRows } = await import("../../components/settings/WindowedRows.tsx");

const ROW = 48;

test("the rows around what's on screen are built, from half a screen above to half a screen below", () => {
  const viewport = 800;
  const top = 300;
  assert.equal(firstRowOf(0, viewport, top, ROW, 1520), 0, "at the top of the page");
  const offset = top + 700 * ROW;
  const first = firstRowOf(offset, viewport, top, ROW, 1520);
  const onScreen = [700, 700 + Math.ceil(viewport / ROW)];
  assert.ok(first <= onScreen[0] - Math.floor(viewport / 2 / ROW) + 1, "half a screen above");
  assert.ok(first + rowSpan(viewport, ROW) >= onScreen[1] + Math.floor(viewport / 2 / ROW), "half a screen below");
  assert.equal(firstRowOf(offset + ROW, viewport, top, ROW, 1520), first, "a row of scrolling keeps the same rows");
  assert.equal(firstRowOf(10_000_000, viewport, top, ROW, 1520), 1519, "never past the last row");
});

test("a list of 1520 logins builds a screenful of rows, each in a recycled slot at its own offset", () => {
  const items = Array.from({ length: 1520 }, (_, i) => `login${i}`);
  const list = mount(() => WindowedRows({ items, rowHeight: ROW, keyOf: (x) => x, render: (x) => x }));
  const box = list.value;
  assert.equal(box.props.style.height, 1520 * ROW, "the list is as tall as every row, so the scroll bar is right");
  const built = box.props.children.filter(Boolean);
  assert.equal(built.length, rowSpan(800, ROW));
  assert.deepEqual(built.map((row) => row.props.style.top).slice(0, 3), [0, ROW, 2 * ROW]);
});
