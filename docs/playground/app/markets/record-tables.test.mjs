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
const { default: AutoOrders, StrategyOrderRequests } = await import("./auto-orders.tsx");
hooks.deregister();

const emptyRecords = { records: [], canDelete: true, onDelete: async () => {} };
const cases = [
  ["告警记录", AlertRecords, emptyRecords, [
    "全选", "交易对", "告警级别", "触发时间", "参考价/触发价 (USDT)", "当日涨跌幅度",
    "窗口涨跌幅/阈值", "窗口 (秒)", "成交额 (USDT)", "核验结果",
  ]],
  ["自动下单任务", AutoOrders, emptyRecords, [
    "全选", "交易对", "策略来源", "触发时间", "最新价 (USDT)", "监控区间 (USDT)", "监控状态",
  ]],
  ["下单请求", StrategyOrderRequests, { strategyId: "spike", requests: [{ strategyId: "other" }] }, [
    "交易对", "请求编号", "方向", "数量", "请求时间",
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
