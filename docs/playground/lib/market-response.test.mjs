import assert from "node:assert/strict";
import { test } from "node:test";
import { readMarketResponse } from "./market-response.ts";

test("plain, HTML and malformed JSON responses use a readable error", async () => {
  const fallback = "行情暂不可用";
  for (const response of [new Response("Internal Server Error", { status: 500 }),
    new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    new Response("Internal Server Error", { status: 500, headers: { "content-type": "application/json" } })]) {
    await assert.rejects(readMarketResponse(response, fallback), { message: fallback });
  }
});

test("market responses preserve valid quotes and JSON API errors", async () => {
  const quote = { symbol: "1000SHIBUSDT", last: 0.004 };
  assert.deepEqual(await readMarketResponse(Response.json(quote), "fallback"), quote);
  await assert.rejects(readMarketResponse(Response.json({ error: "稍后重试" }, { status: 429 }), "fallback"), { message: "稍后重试" });
});
