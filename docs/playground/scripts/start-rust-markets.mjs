import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createInterface } from "node:readline";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadEnvFile(file);
}

const target = resolve("market-service", "target");
const production = process.argv[2] === "--production";
const monitorOnly = process.argv[2] === "--monitor-only";
const appPort = process.env.PLAYGROUND_PORT || process.env.PORT || "3000";
const children = new Set();
const stopping = new AbortController();
const windows = process.platform === "win32";
const executable = `playground-market-service${windows ? ".exe" : ""}`;

async function selectBackend() {
  if (production) return resolve("market-service", "bin", executable);

  const platform = `${process.platform}-${process.arch}`;
  const prebuilt = resolve("market-service", "bin", platform, executable);
  if (process.env.PLAYGROUND_BUILD_RUST !== "1" && existsSync(prebuilt)) {
    console.log(`使用预编译 Rust 行情服务（${platform}）。`);
    return prebuilt;
  }
  if (!existsSync(resolve("market-service", "Cargo.toml"))) {
    throw new Error(`缺少适用于 ${platform} 的 Rust 后端，请将预编译文件放到 ${prebuilt}。`);
  }
  const build = await buildRust();
  if (build.code !== 0) throw new Error("Rust 行情服务编译失败，请检查 Rust 和 C/C++ 构建工具。");
  return resolve(target, "debug", executable);
}

function buildRust() {
  const args = ["build", "--locked", "--manifest-path", "market-service/Cargo.toml", "--target-dir", target];
  const rustupHome = resolve("..", "..", "tmp", "playground-rustup");
  const architecture = { x64: "x86_64", arm64: "aarch64", ia32: "i686" }[process.arch];
  const toolchain = resolve(rustupHome, "toolchains", `stable-${architecture}-pc-windows-msvc`, "bin");
  const cargo = resolve(toolchain, "cargo.exe");
  if (windows && !process.env.RUSTUP_HOME && !process.env.RUSTUP_TOOLCHAIN && existsSync(cargo)) {
    return start(cargo, args, { env: {
      ...process.env,
      CARGO_HOME: process.env.CARGO_HOME || resolve("..", "..", "tmp", "playground-cargo"),
      RUSTC: resolve(toolchain, "rustc.exe"),
    } }).done;
  }
  return start("cargo", args).done;
}

function start(program, args, { env = process.env, readAddress = false } = {}) {
  const child = spawn(program, args, {
    env, stdio: ["inherit", readAddress ? "pipe" : "inherit", "inherit"],
    detached: !windows, windowsHide: true,
  });
  children.add(child);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => { children.delete(child); });
  return { child, done };
}

async function ready(stream, exited) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const connect = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      const match = /^PLAYGROUND_MARKET_SERVICE_ADDRESS=(127\.0\.0\.1:(\d{1,5}))$/.exec(line);
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) resolve(`http://${match[1]}`);
    });
    lines.once("error", reject);
  });
  const timeout = AbortSignal.timeout(15_000);
  const timedOut = new Promise((_, reject) => {
    timeout.addEventListener("abort", () => reject(new Error("Rust 行情服务启动超时。")), { once: true });
  });
  try {
    return await Promise.race([connect, exited, timedOut]);
  } finally {
    lines.close();
    stream.resume();
  }
}

function stop() {
  if (stopping.signal.aborted) return;
  stopping.abort();
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    if (windows) {
      const taskkill = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      if (spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).status !== 0) {
        child.kill();
      }
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const binary = await selectBackend();
  stopping.signal.throwIfAborted();
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "::1"].filter(Boolean).join(",");
  const env = { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy,
    PLAYGROUND_LOCAL_SETTINGS: production ? "0" : "1",
    PLAYGROUND_MARKET_SERVICE_TOKEN: production ? "" : randomBytes(32).toString("hex"),
  };
  const backend = start(binary, [], {
    env: { ...env, PLAYGROUND_MARKET_SERVICE_BIND: "127.0.0.1:0" }, readAddress: true,
  });
  const backendExit = backend.done.then(({ code }) => { throw new Error(`Rust 行情服务已退出（${code ?? "signal"}）。`); });
  const backendUrl = await ready(backend.child.stdout, backendExit);
  stopping.signal.throwIfAborted();
  console.log(`Rust 行情服务已启动（${backendUrl}）。`);
  if (monitorOnly) {
    await backendExit;
  } else {
    const args = ["node_modules/next/dist/bin/next", production ? "start" : "dev",
      "--hostname", production ? "0.0.0.0" : "127.0.0.1", "--port", appPort];
    const next = start(process.execPath, args, { env: { ...env, PLAYGROUND_MARKET_SERVICE_URL: backendUrl } });
    const outcome = await Promise.race([next.done, backendExit]);
    if (outcome.code !== 0 && !stopping.signal.aborted) throw new Error("Next.js 已异常退出。");
  }
} catch (error) {
  if (!stopping.signal.aborted) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  stop();
}
