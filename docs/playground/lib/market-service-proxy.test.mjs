import assert from "node:assert/strict";
import { test } from "node:test";

import { proxyMarketRequest } from "./market-service-proxy.ts";
import { isLocalSettingsRequest, isSameOrigin, readLocalJson } from "./local-settings-request.ts";

test("local JSON checks the origin and caps streamed bytes", async (t) => {
  const savedMode = process.env.PLAYGROUND_LOCAL_SETTINGS;
  t.after(() => {
    if (savedMode === undefined) delete process.env.PLAYGROUND_LOCAL_SETTINGS;
    else process.env.PLAYGROUND_LOCAL_SETTINGS = savedMode;
  });
  process.env.PLAYGROUND_LOCAL_SETTINGS = "1";
  const host = "localhost:3000";
  const origin = `http://${host}`;
  const headers = { host, origin, "content-type": "application/json", "sec-fetch-site": "same-origin" };
  const request = new Request("http://127.0.0.1:3000/api/strategy-notifications", { method: "POST", headers, body: "{}" });
  assert.equal(isLocalSettingsRequest(request), true);
  assert.equal(isSameOrigin(request), true);
  request.headers.set("origin", "https://localhost:3000");
  assert.equal(isSameOrigin(request), false);
  assert.equal((await readLocalJson(request)).status, 200);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      controller.enqueue(Uint8Array.of(0));
      controller.close();
    },
  });
  const oversized = new Request(origin, { method: "POST", headers, body: stream, duplex: "half" });
  assert.equal((await readLocalJson(oversized)).status, 413);
});

test("market routes return 503 when Rust is missing or unavailable", async (t) => {
  const savedUrl = process.env.PLAYGROUND_MARKET_SERVICE_URL;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.PLAYGROUND_MARKET_SERVICE_URL;
    else process.env.PLAYGROUND_MARKET_SERVICE_URL = savedUrl;
  });
  delete process.env.PLAYGROUND_MARKET_SERVICE_URL;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("service unavailable"); });
  const route = "/api/markets/ticker";
  const request = new Request(`http://localhost${route}?symbol=BTCUSDT`);
  assert.equal((await proxyMarketRequest(route, request)).status, 503);
  assert.equal(fetch.mock.callCount(), 0);
  process.env.PLAYGROUND_MARKET_SERVICE_URL = "http://127.0.0.1:3101";
  assert.equal((await proxyMarketRequest(route, request)).status, 503);
  assert.equal(fetch.mock.calls[0].arguments[0].href, `http://127.0.0.1:3101${route}?symbol=BTCUSDT`);
});

test("proxy keeps the internal token on loopback settings routes", async (t) => {
  const token = "a".repeat(64);
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "unconfigured" }));
  const [publicRoute, privateRoute] = ["/api/markets/contracts", "/api/strategy-notifications"];
  const savedUrl = process.env.PLAYGROUND_MARKET_SERVICE_URL;
  const savedToken = process.env.PLAYGROUND_MARKET_SERVICE_TOKEN;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.PLAYGROUND_MARKET_SERVICE_URL;
    else process.env.PLAYGROUND_MARKET_SERVICE_URL = savedUrl;
    if (savedToken === undefined) delete process.env.PLAYGROUND_MARKET_SERVICE_TOKEN;
    else process.env.PLAYGROUND_MARKET_SERVICE_TOKEN = savedToken;
  });
  process.env.PLAYGROUND_MARKET_SERVICE_TOKEN = token;
  process.env.PLAYGROUND_MARKET_SERVICE_URL = "http://192.0.2.1:3101";
  const request = new Request("http://localhost", { headers: { authorization: "Bearer caller" } });
  assert.equal((await proxyMarketRequest(privateRoute, request)).status, 503);
  assert.equal(fetch.mock.callCount(), 0);
  await proxyMarketRequest(publicRoute, request);
  assert.equal(fetch.mock.calls[0].arguments[1].headers.has("authorization"), false);

  process.env.PLAYGROUND_MARKET_SERVICE_URL = "http://127.0.0.1:3101";
  await proxyMarketRequest(privateRoute, request);
  const { headers, dispatcher } = fetch.mock.calls[1].arguments[1];
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.ok(dispatcher);
});
