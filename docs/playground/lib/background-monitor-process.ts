import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { backgroundStore, monitorDatabasePath } from "./background-monitor-store";

let starting: Promise<void> | undefined;
let nextAttempt = 0;

/** The local web service can start a worker without owning its lifetime. */
export function ensureBackgroundMonitor() {
  const store = backgroundStore();
  if (!store.rule().enabled || store.workerState(Date.now()) !== "offline") return;
  if (starting) return starting;
  if (Date.now() < nextAttempt) return;
  nextAttempt = Date.now() + 10_000;
  starting = startWorker(store).then(() => {
    if (!store.rule().enabled || store.workerState(Date.now()) !== "offline") nextAttempt = 0;
  }).catch((error: unknown) => {
    console.error("无法启动行情监控进程。", error instanceof Error ? error.message : error);
  }).finally(() => { starting = undefined; });
  return starting;
}

async function startWorker(store: ReturnType<typeof backgroundStore>) {
  const cwd = process.cwd();
  const logDir = path.dirname(path.resolve(monitorDatabasePath()));
  mkdirSync(logDir, { recursive: true });
  const log = openSync(path.join(logDir, "worker.log"), "a");
  let exited = false;
  try {
    const child = spawn(process.execPath, [path.join(cwd, "scripts", "market-monitor.mjs"), "--managed"], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    child.once("error", (error) => {
      exited = true;
      console.error("无法启动行情监控进程。", error.message);
    });
    child.once("exit", () => { exited = true; });
    child.unref();
  } finally {
    closeSync(log);
  }
  for (let attempt = 0; attempt < 20 && !exited; attempt++) {
    if (!store.rule().enabled || store.workerState(Date.now()) !== "offline") return;
    await delay(200);
  }
}
