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
  ["下单记录", TradeRecords, { trades: [], activeMode: "off", onClose: async () => {} }, [
    "交易对", "策略", "账户", "方向", "数量 / 金额", "开仓价", "止损 / 止盈", "状态", "盈亏 (USDT)", "开仓时间", "订单", "操作",
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
