import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDingTalkSettings, createStrategyNotifier } from "./strategy-notifications.ts";

const eventsModule = new URL("./strategy-notification-events.ts", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === eventsModule.href && /^\.\/[a-z-]+$/.test(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { createMarketSpikeEvent, formatNotificationEvent } = await import(eventsModule.href);
hooks.deregister();

const webhook = "https://oapi.dingtalk.com/robot/send?access_token=example";
const now = Date.UTC(2026, 10, 12, 2, 0, 0);
const alert = createMarketSpikeEvent({
  symbol: "币安人生USDT", time: now, level: 2, seconds: 30,
  previous: 0.002, price: 0.0019, change: -5, threshold: -5,
}, { baseline: 120_000, turnover: 390_000, multiple: 3.25 }, 0.00191);

test("uses a fixed template for market spike alerts", () => {
  const message = formatNotificationEvent(alert);
  assert.equal(message.title, "异动监控｜币安人生USDT 2 级告警");
  assert.match(message.lines.join("\n"), /2026\/11\/12 10:00:00（北京时间）/);
  assert.match(message.lines.join("\n"), /-5%.*-5%/);
  assert.ok(message.lines.includes("成交额3.25倍(12万 -> 39万)"));
  assert.ok(message.lines.includes("涨跌预测：上涨"));
  assert.equal(formatNotificationEvent({ ...alert, price: "0.0019" }), null);
  assert.equal(formatNotificationEvent({ ...alert, symbol: "BTC\n伪造消息" }), null);
  assert.equal(formatNotificationEvent({ kind: "other", text: "伪造消息" }), null);
  assert.equal(formatNotificationEvent({ ...alert, forecastDirection: "sideways" }), null);
  const { forecastDirection, volume, ...legacy } = alert;
  const legacyMessage = formatNotificationEvent({ ...legacy, multiple: volume.multiple });
  assert.ok(legacyMessage.lines.includes("成交额3.25倍"));
  assert.ok(legacyMessage.lines.includes("涨跌预测：下跌"));
  assert.equal(legacyMessage.deduplicationKey, message.deduplicationKey);
  assert.doesNotMatch(formatNotificationEvent(legacy).lines.join("\n"), /成交额/);
  assert.deepEqual(formatNotificationEvent({ ...alert, text: "自定义消息" }), message);
});

test("uses the default test message for blank text and rejects invalid custom text", () => {
  const fallback = { title: "钉钉推送测试", lines: ["交易策略通知已连通。"] };
  assert.deepEqual(formatNotificationEvent({ kind: "test" }), fallback);
  assert.deepEqual(formatNotificationEvent({ kind: "test", text: " \n " }), fallback);
  assert.equal(formatNotificationEvent({ kind: "test", text: 42 }), null);
  assert.equal(formatNotificationEvent({ kind: "test", text: "测".repeat(501) }), null);
  assert.equal(formatNotificationEvent({ kind: "test", text: "测".repeat(500) }).lines[0].length, 500);
});

test("sends multiline custom text through the configured robot as a test message", async (t) => {
  const request = t.mock.fn(async () => Response.json({ errcode: 0 }));
  const notifier = createStrategyNotifier(() => ({ webhook }), request);
  const message = formatNotificationEvent({ kind: "test", text: "  你好，钉钉！\n第二行 ✅  " });
  assert.equal(await notifier.send(message), "sent");
  const [url, options] = request.mock.calls[0].arguments;
  assert.equal(url.href, webhook);
  assert.deepEqual(JSON.parse(options.body), {
    msgtype: "text", text: { content: "【CCXT】钉钉推送测试\n你好，钉钉！\n第二行 ✅" },
  });
});

test("sends a confirmed market spike as signed text without exposing credentials in the message", async () => {
  const send = async (url, options) => {
    assert.equal(url.origin, "https://oapi.dingtalk.com");
    assert.equal(url.searchParams.get("access_token"), "example");
    assert.equal(url.searchParams.get("timestamp"), String(now));
    assert.equal(url.searchParams.get("sign"), "dOoSryx4mEK3cqMsCUnyJbO5k+jD8KZh911LONpAAf4=");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), {
      msgtype: "text", text: { content: [
        "【CCXT】异动监控｜币安人生USDT 2 级告警",
        "2026/11/12 10:00:00（北京时间）",
        "30 秒窗口 · 涨跌 -5% · 阈值 -5%",
        "参考价 0.002 → 触发价 0.0019 USDT",
        "成交额3.25倍(12万 -> 39万)",
        "涨跌预测：上涨",
      ].join("\n") },
    });
    return Response.json({ errcode: 0, errmsg: "ok" });
  };
  const notifier = createStrategyNotifier(() => ({ webhook, secret: "SEC-example" }), send, () => now);
  assert.equal(await notifier.send(formatNotificationEvent(alert)), "sent");
});

test("skips empty or invalid Webhook configuration", async (t) => {
  const noRequest = t.mock.fn();
  const message = formatNotificationEvent(alert);
  for (const [config, status] of [
    [{}, "unconfigured"],
    [{ webhook: "https://oapi.dingtalk.com.example.org/robot/send?access_token=x" }, "invalid"],
    [{ webhook: "https://oapi.dingtalk.com/robot/sendBySession?session=x" }, "invalid"],
    [{ webhook: "http://oapi.dingtalk.com/robot/send?access_token=x" }, "invalid"],
    [{ webhook: "https://oapi.dingtalk.com/robot/send" }, "invalid"],
  ]) {
    const notifier = createStrategyNotifier(() => config, noRequest);
    assert.equal(await notifier.status(), status);
    assert.equal(await notifier.send(message), status);
  }
  assert.equal(noRequest.mock.callCount(), 0);
});

test("web settings replace the environment credentials and persist pause across restarts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ccxt-dingtalk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config", "dingtalk.json");
  const environment = () => ({ webhook, secret: "SEC-environment" });
  const openSettings = () => createDingTalkSettings(file, environment);
  const settings = openSettings();
  const request = t.mock.fn(async () => Response.json({ errcode: 0 }));
  const notifier = createStrategyNotifier(openSettings().read, request);
  const message = formatNotificationEvent({ kind: "test" });

  assert.equal(await notifier.status(), "ready");
  assert.equal(await settings.save({ enabled: false }), "paused");
  assert.equal(await notifier.send(message), "paused");
  assert.equal(request.mock.callCount(), 0);

  const newWebhook = "https://oapi.dingtalk.com/robot/send?access_token=new-robot";
  assert.equal(await settings.save({ webhook: newWebhook, secret: "" }), "ready");
  assert.equal(await settings.save({ webhook: "https://example.com/robot/send?access_token=x", secret: "" }), "invalid");
  assert.equal(await notifier.send(message), "sent");
  const [url] = request.mock.calls[0].arguments;
  assert.equal(url.href, newWebhook);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { webhook: newWebhook, secret: "", enabled: true });

  assert.deepEqual(await Promise.all([settings.save({ enabled: false }), settings.save({ enabled: true })]), ["paused", "ready"]);
  assert.equal((await openSettings().read()).webhook, newWebhook);
  assert.equal(await notifier.status(), "ready");
});

test("deduplicates concurrent alerts and applies the robot rate limit", async (t) => {
  let time = now;
  const send = t.mock.fn(async () => Response.json({ errcode: 0 }));
  const notifier = createStrategyNotifier(() => ({ webhook }), send, () => time);
  const message = formatNotificationEvent(alert);
  assert.deepEqual(await Promise.all([notifier.send(message), notifier.send(message)]), ["sent", "duplicate"]);
  for (let i = 0; i < 19; i++) assert.equal(await notifier.send({ title: "测试", lines: [] }), "sent");
  assert.equal(await notifier.send({ title: "测试", lines: [] }), "rate-limited");
  assert.equal(send.mock.callCount(), 20);
  time += 60_000;
  assert.equal(await notifier.send({ title: "测试", lines: [] }), "sent");
});

test("recognizes DingTalk business errors and allows a failed alert to be resent", async () => {
  const responses = [Response.json({ errcode: 310000, errmsg: "sensitive detail" }),
    new Response("bad gateway", { status: 502 }), Response.json({ errcode: 0 })];
  const notifier = createStrategyNotifier(() => ({ webhook }), async () => responses.shift());
  const message = formatNotificationEvent(alert);
  assert.equal(await notifier.send(message), "failed");
  assert.equal(await notifier.send(message), "failed");
  assert.equal(await notifier.send(message), "sent");
});
