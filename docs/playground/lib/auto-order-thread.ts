import { Worker } from "node:worker_threads";
import type { StartAutoOrderThread } from "./auto-order";

export const startAutoOrderThread: StartAutoOrderThread = (symbol, report, fail) => {
  const worker = new Worker(new URL("../scripts/auto-order-worker.mjs", import.meta.url), { name: symbol });
  worker.on("message", report);
  worker.on("error", fail);
  worker.on("exit", fail);
  return { quote: (tick) => worker.postMessage(tick), stop: () => { void worker.terminate(); } };
};
