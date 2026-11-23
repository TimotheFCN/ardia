import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const start = script.indexOf("    const MAX_SECRET = ");
const end = script.indexOf("    const stopScanning = ", start);
assert.ok(start > 0 && end > start, "page_script.js has the vault login offer");
const source = script.slice(start, end);

const input = (type, value, extra = {}) => ({ localName: "input", type, value, disabled: false, ...extra });

function formOf(...inputs) {
  const form = { localName: "form", querySelectorAll: () => inputs, querySelector: () => inputs.find((i) => i.type === "password") ?? null };
  for (const i of inputs) i.form = form;
  return form;
}

function offered(form, config = { host: true, login: true, generation: 3 }) {
  const sent = [];
  const offerLogin = new Function("config", "send", "guard", "revealed", `${source}return offerLogin;`)(config, (kind, data) => sent.push({ kind, data }), (f) => f, () => null);
  offerLogin(form);
  return sent;
}

test("a submitted login sends its username and password once, with the provider's generation", () => {
  const form = formOf(input("email", "me@example.com"), input("password", "hunter2"));
  assert.deepEqual(offered(form), [{ kind: "vaultLogin", data: { username: "me@example.com", password: "hunter2", generation: 3 } }]);
});

test("a sign-up sends the new password once, and a change of password sends the new one, not the current one", () => {
  assert.equal(offered(formOf(input("text", "me"), input("password", "new"), input("password", "new")))[0].data.password, "new");
  assert.equal(offered(formOf(input("text", "me"), input("password", "old"), input("password", "new"), input("password", "new")))[0].data.password, "new");
  assert.equal(offered(formOf(input("password", "old"), input("password", "new")))[0].data.password, "new");
});

test("nothing is sent outside a vault profile, without a password, or past the size limit", () => {
  const form = () => formOf(input("text", "me"), input("password", "pw"));
  assert.deepEqual(offered(form(), { host: false, login: true, generation: 1 }), [], "Ardia's own or the system's manager");
  assert.deepEqual(offered(form(), null), [], "no provider");
  assert.deepEqual(offered(formOf(input("text", "me"), input("password", ""))), []);
  assert.deepEqual(offered(formOf(input("password", "x".repeat(1025)))), []);
  assert.deepEqual(offered(formOf(input("text", "x".repeat(1025)), input("password", "pw"))), []);
});

test("the same login submitted twice is offered once", () => {
  const sent = [];
  const offerLogin = new Function("config", "send", "guard", "revealed", `${source}return offerLogin;`)({ host: true, login: true, generation: 1 }, (kind, data) => sent.push(data), (f) => f, () => null);
  const form = formOf(input("text", "me"), input("password", "pw"));
  offerLogin(form);
  offerLogin(form.querySelectorAll()[1]);
  assert.equal(sent.length, 1);
});

const rectStart = script.indexOf("    const trailingRect = ");
const rectEnd = script.indexOf("    const hideHint = ", rectStart);
const rectSource = script.slice(rectStart, rectEnd);

function keyLeft({ host, toggle, direction = "ltr" }) {
  const field = { getBoundingClientRect: () => ({ left: 100, right: 500, top: 50, bottom: 90, height: 40 }) };
  const cs = { direction, paddingLeft: "8px", paddingRight: "8px", borderLeftWidth: "1px", borderRightWidth: "1px" };
  const ownToggle = () => (toggle ? { getBoundingClientRect: () => toggle } : null);
  const trailingRect = new Function("getComputedStyle", "fieldInk", "KEY_ASPECT", "config", "ownToggle", `${rectSource}return trailingRect;`)(() => cs, () => "#000", 1.4, { host }, ownToggle);
  const { left, width } = trailingRect(field);
  return { left, right: left + width };
}

test("in a vault profile the key sits just before a site's own show-password button instead of on it", () => {
  const eye = { left: 460, right: 492, top: 54, bottom: 86, width: 32 };
  assert.equal(keyLeft({ host: true, toggle: eye }).right, eye.left - 4);
  assert.deepEqual(keyLeft({ host: false, toggle: eye }), keyLeft({ host: false, toggle: null }), "other managers keep the trailing edge (and hide the key there)");
  const below = { left: 460, right: 492, top: 120, bottom: 150, width: 32 };
  assert.deepEqual(keyLeft({ host: true, toggle: below }), keyLeft({ host: true, toggle: null }), "a button outside the field moves nothing");
  const rtlEye = { left: 108, right: 140, top: 54, bottom: 86, width: 32 };
  assert.equal(keyLeft({ host: true, toggle: rtlEye, direction: "rtl" }).left, rtlEye.right + 4);
});
