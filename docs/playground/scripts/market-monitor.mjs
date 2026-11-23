import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const root = new URL("../", import.meta.url);
process.chdir(fileURLToPath(root));
for (const name of [".env.local", ".env"]) {
  if (existsSync(name)) loadEnvFile(name);
}
process.env.PLAYGROUND_LOCAL_SETTINGS ??= "1";

// The Playground's TypeScript imports are extensionless for Next.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(root.href) &&
        !context.parentURL.includes("/node_modules/")) {
      const source = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const dispatcher = new EnvHttpProxyAgent();
setGlobalDispatcher(dispatcher);
const lifecycle = new AbortController();
process.once("SIGINT", () => lifecycle.abort());
process.once("SIGTERM", () => lifecycle.abort());
const { runBackgroundMonitor } = await import("../lib/background-monitor.ts");
console.log("异动监控进程已启动，规则在行情页的「异动监控」中设置。");
try {
  await runBackgroundMonitor(lifecycle.signal, dispatcher, process.argv.includes("--managed"));
} finally {
  await dispatcher.destroy();
}
