import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    if (/\.tsx?$/.test(context.parentURL ?? "") && specifier.startsWith(".") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return { format: "module", source: "export default {}", shortCircuit: true };
    }
    if (/\.tsx?$/.test(url)) {
      const { source } = nextLoad(url, { ...context, format: "module" });
      const { outputText } = ts.transpileModule(source.toString(), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { default: AlertRecords } = await import("./alert-records.tsx");
const { default: TradeRecords } = await import("./trade-records.tsx");
const { default: TestStrategy } = await import("./test-strategy.tsx");
const { default: BinanceSettings } = await import("./binance-settings.tsx");
hooks.deregister();

const emptyRecords = { records: [], canDelete: true, onDelete: async () => {} };
const cases = [
  ["告警记录", AlertRecords, emptyRecords, [
    "全选", "交易对", "告警级别", "触发时间", "参考价/触发价 (USDT)", "当日涨跌幅度",
    "窗口涨跌幅/阈值", "窗口 (秒)", "成交额 (USDT)", "核验结果",
  ]],
  ["下单记录", TradeRecords, { trades: [], activeMode: "off", canDelete: true, onDelete: async () => {}, onClose: async () => {} }, [
    "全选", "交易对", "状态", "净盈亏 (USDT)", "实际成交均价", "手续费 (USDT)", "开仓时间", "操作",
  ]],
];

for (const [label, Component, props, columns] of cases) {
  test(`${label} keeps its column headers when empty`, () => {
    const html = renderToStaticMarkup(createElement(Component, props));
    const headers = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)]
      .map(([, content]) => content.replace(/<[^>]+>/g, ""));
    assert.deepEqual(headers, columns);
    assert.match(html, new RegExp(`<tbody><tr><td[^>]*colSpan="${columns.length}"[^>]*><span role="status">暂无${label}。</span></td></tr></tbody>`));
    if (columns[0] === "全选") assert.match(html, /<input[^>]*disabled=""[^>]*>/);
  });
}

test("trade selection includes finished trades and protects active trades", () => {
  const fixture = {
    mode: "demo", side: "long", strategy: { name: "测试策略" }, leverage: 2,
    amount: 1, notional: 20, entryPrice: 20, exitPrice: null, orders: [],
    openedAt: Date.UTC(2026, 10, 24), deadline: Date.UTC(2026, 10, 25),
  };
  const html = renderToStaticMarkup(createElement(TradeRecords, {
    trades: [
      { ...fixture, id: "active", symbol: "BTCUSDT", status: "open" },
      { ...fixture, id: "finished", symbol: "ETHUSDT", status: "closed" },
    ],
    activeMode: "demo", canDelete: true, onDelete: async () => {}, onClose: async () => {},
  }));
  const checkboxes = [...html.matchAll(/<input[^>]+type="checkbox"[^>]*>/g)].map(([input]) => input);
  assert.equal(checkboxes.length, 3);
  assert.doesNotMatch(checkboxes[0], /disabled=""/);
  assert.match(checkboxes[1], /disabled="".*选择 BTCUSDT/);
  assert.doesNotMatch(checkboxes[2], /disabled=""/);
  assert.match(checkboxes[0], /全选筛选结果中所有已结束的下单记录/);
});

test("trade rows show confirmed fills and combined fees with details collapsed", () => {
  const trade = {
    id: "trade", mode: "demo", side: "long", symbol: "BTCUSDT", strategy: { name: "测试策略" },
    leverage: 1, amount: 1, notional: 100, entryPrice: 100, exitPrice: 110, status: "closed",
    openedAt: 1, deadline: 2, stopLoss: 90, takeProfit: 110, orders: [
      { kind: "entry", side: "buy", triggerPrice: null, status: "filled", execution: { filled: 1, quote: 100 } },
      { kind: "take-profit", side: "sell", triggerPrice: 110, status: "triggered", execution: { filled: 1, quote: 108 } },
    ],
  };
  const html = renderToStaticMarkup(createElement(TradeRecords, {
    trades: [trade], activeMode: "demo", canDelete: true, onDelete: async () => {}, onClose: async () => {},
  }));
  assert.match(html, /开仓<\/small>100/);
  assert.match(html, /平仓<\/small>108/);
  assert.match(html, />0\.104<\/td>/);
  assert.match(html, /\+7\.896/);
  assert.match(html, /aria-expanded="false">详情/);
  assert.doesNotMatch(html, /止损 \/ 止盈触发价|>订单明细</);
});

test("trade records limit each page while preserving cross-page select all", () => {
  const trades = Array.from({ length: 12 }, (_, index) => ({
    id: String(index), symbol: `TEST${index}USDT`, strategy: { name: "测试策略" },
    mode: "demo", side: "long", leverage: 1, status: "closed", openedAt: index + 1, orders: [],
  }));
  const html = renderToStaticMarkup(createElement(TradeRecords, {
    trades, activeMode: "demo", canDelete: true, onDelete: async () => {}, onClose: async () => {},
  }));
  assert.equal((html.match(/<th scope="row">/g) ?? []).length, 10);
  assert.match(html, /TEST9USDT/);
  assert.doesNotMatch(html, /TEST10USDT/);
  assert.match(html, /第 1–10 条，共 12 条/);
  assert.match(html, /全选（跨页）/);
  assert.match(html, /<button type="button">下一页<\/button>/);
});

test("the test order direction menu contains long and short only", () => {
  const html = renderToStaticMarkup(createElement(TestStrategy, { mode: "local", status: null }));
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value), ["long", "short"]);
});

test("the account settings only show logout while an account is connected", () => {
  const html = renderToStaticMarkup(createElement(BinanceSettings, {
    availability: "local", status: { mode: "live", enabled: true }, error: "",
  }));
  assert.match(html, /已登录 实盘/);
  assert.match(html, />登出<\/button>/);
  assert.doesNotMatch(html, /<select|type="password"|>登录<\/button>/);
});

test("while signed out, only demo and live can be selected for login", () => {
  const html = renderToStaticMarkup(createElement(BinanceSettings, {
    availability: "local", status: { mode: "off", enabled: false }, error: "",
  }));
  assert.match(html, />登录<\/button>/);
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value), ["demo", "live"]);
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
});
