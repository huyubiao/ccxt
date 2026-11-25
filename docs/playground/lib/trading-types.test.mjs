import assert from "node:assert/strict";
import { test } from "node:test";
import { tradeExecution } from "./trading-types.ts";

test("combines partial exits before calculating long and short net PnL", () => {
  const orders = [
    { kind: "entry", execution: { filled: 1, quote: 100 } },
    { kind: "stop-loss", execution: { filled: 0.4, quote: 36 } },
    { kind: "exit", execution: { filled: 0.6, quote: 57 } },
  ];
  const summary = tradeExecution({ side: "long", orders });
  assert.equal(summary.entryPrice, 100);
  assert.equal(summary.exitPrice, 93);
  assert.equal(summary.entryFee, 0.05);
  assert.equal(summary.exitFee, 0.0465);
  assert.ok(Math.abs(summary.netPnl - (-7.0965)) < 1e-10);
  assert.ok(Math.abs(tradeExecution({ side: "short", orders }).netPnl - 6.9035) < 1e-10);
});

test("does not turn a trigger or unverified historic price into an execution", () => {
  const orders = [
    { kind: "entry", execution: { filled: 1, quote: 100 } },
    { kind: "take-profit", triggerPrice: 110, average: 110, execution: null },
  ];
  assert.deepEqual(tradeExecution({ side: "long", orders }), {
    entryPrice: 100, exitPrice: null, entryFee: 0.05, exitFee: null, netPnl: null,
  });
  orders[1].execution = { filled: 0.5, quote: 55 };
  assert.equal(tradeExecution({ side: "long", orders }).netPnl, null);
});
