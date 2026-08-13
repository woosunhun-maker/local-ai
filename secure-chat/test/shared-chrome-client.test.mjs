import assert from "node:assert/strict";
import test from "node:test";
import { SharedChromeClient } from "../src/browser/shared-chrome-client.mjs";

test("shared Chrome client is pinned to the extension profile and exposes only selected tab metadata", async () => {
  const calls = [];
  const client = new SharedChromeClient({ runner: async (args) => {
    calls.push(args);
    return JSON.stringify({ tabs: [
      { targetId: "coupang-tab", url: "https://www.coupang.com/", title: "쿠팡" },
      { targetId: "gmail-tab", url: "https://mail.google.com/mail/u/0/#inbox", title: "받은편지함" },
      { targetId: "other-tab", url: "https://example.com/", title: "공유됐지만 허용하지 않는 탭" },
    ] });
  } });
  const tabs = await client.tabs();
  assert.deepEqual(tabs.map((tab) => tab.service), ["coupang", "gmail", null]);
  assert.deepEqual(calls[0].slice(0, 5), ["browser", "--browser-profile", "chrome", "--json", "tabs"]);
});

test("snapshot is bounded and raw cookies, storage, evaluate, upload and response bodies have no API", async () => {
  const calls = [];
  const client = new SharedChromeClient({ runner: async (args) => {
    calls.push(args);
    return JSON.stringify({ format: "ai", snapshot: "button 장바구니 [ref=e7]" });
  } });
  const result = await client.snapshot("shared-tab-1");
  assert.match(result.snapshot, /장바구니/);
  assert.equal(typeof client.cookies, "undefined");
  assert.equal(typeof client.storage, "undefined");
  assert.equal(typeof client.evaluate, "undefined");
  assert.equal(typeof client.upload, "undefined");
  assert.equal(typeof client.responseBody, "undefined");
  assert.equal(calls[0].includes("--target-id"), true);
});

test("Coupang navigation and clicks remain pinned to exact allowed origins", async () => {
  const calls = [];
  const client = new SharedChromeClient({ runner: async (args) => {
    calls.push(args);
    if (args.includes("navigate")) return JSON.stringify({ ok: true, url: "https://www.coupang.com/np/search?q=%EC%83%9D%EC%88%98" });
    return JSON.stringify({ ok: true, url: "https://evil.example/checkout" });
  } });
  await client.navigateCoupangSearch("tab-1", "생수");
  await assert.rejects(() => client.click("tab-1", "e7", "coupang"), /browser_origin_changed/);
  assert.equal(calls.flat().includes("evaluate"), false);
});

test("browser errors are content-free and invalid refs fail before executing", async () => {
  let called = false;
  const client = new SharedChromeClient({ runner: async () => {
    called = true;
    throw new Error("SECRET PAGE CONTENT");
  } });
  await assert.rejects(() => client.click("tab-1", "javascript:alert(1)", "coupang"), /invalid_browser_ref/);
  assert.equal(called, false);
});

test("credential-shaped search input is rejected before it reaches browser argv", async () => {
  let called = false;
  const client = new SharedChromeClient({ runner: async () => {
    called = true;
    return JSON.stringify({ ok: true, url: "https://www.coupang.com/" });
  } });
  const lgPat = ["thinq", "pat_", "B".repeat(48)].join("");
  await assert.rejects(
    () => client.navigateCoupangSearch("tab-1", `공기청정기 ${lgPat}`),
    /credential_in_browser_query/,
  );
  assert.equal(called, false);
});
