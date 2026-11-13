import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DINGTALK_ORIGIN = "https://oapi.dingtalk.com";
const RATE_WINDOW_MS = 60_000;
const SEND_LIMIT = 20;

export type StrategyNotification = {
  title: string;
  lines: readonly string[];
  deduplicationKey?: string;
};

export type NotificationConfigStatus = "ready" | "paused" | "unconfigured" | "invalid" | "config-unavailable";
export type NotificationDelivery = Exclude<NotificationConfigStatus, "ready"> | "sent" | "duplicate" | "rate-limited" | "failed";
type Configuration = { webhook?: string; secret?: string; enabled?: boolean };

function readWebhook(value?: string): URL | "unconfigured" | "invalid" {
  if (!value?.trim()) return "unconfigured";
  const url = URL.parse(value.trim());
  if (!url || url.origin !== DINGTALK_ORIGIN || url.pathname !== "/robot/send" ||
      url.username || url.password || url.hash || url.searchParams.getAll("access_token").length !== 1 ||
      !url.searchParams.get("access_token")?.trim()) return "invalid";
  return url;
}

export function createDingTalkSettings(file: string, readEnv: () => Configuration) {
  let pendingWrite: Promise<unknown> = Promise.resolve();

  async function readSaved(): Promise<Configuration> {
    const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (raw === null) return {};
    const saved = JSON.parse(raw) as Configuration | null;
    if (!saved || typeof saved.enabled !== "boolean" ||
        (saved.webhook !== undefined && typeof saved.webhook !== "string") ||
        (saved.secret !== undefined && typeof saved.secret !== "string")) throw new Error("Invalid DingTalk settings");
    return saved;
  }

  async function read(): Promise<Configuration> {
    const saved = await readSaved();
    const credentials = saved.webhook === undefined ? readEnv() : saved;
    return { webhook: credentials.webhook, secret: credentials.secret, enabled: saved.enabled };
  }

  function save(change: { webhook: string; secret: string } | { enabled: boolean }): Promise<NotificationConfigStatus> {
    const result = pendingWrite.then(async (): Promise<NotificationConfigStatus> => {
      const saved = "webhook" in change
        ? { webhook: change.webhook.trim(), secret: change.secret.trim(), enabled: true }
        : { ...await readSaved(), enabled: change.enabled };
      const webhook = readWebhook(saved.webhook ?? readEnv().webhook);
      if (typeof webhook === "string") return webhook;

      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(saved), { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return saved.enabled ? "ready" : "paused";
    }).catch((): NotificationConfigStatus => "config-unavailable");
    pendingWrite = result;
    return result;
  }

  return { read, save };
}

export function createStrategyNotifier(
  readConfig: () => Configuration | Promise<Configuration>,
  fetchWebhook: typeof fetch = (...args) => fetch(...args),
  clock: () => number = Date.now,
) {
  const attempts: number[] = [];
  const recent = new Map<string, number>();

  async function destination() {
    try {
      const { webhook, secret, enabled } = await readConfig();
      const url = readWebhook(webhook);
      if (typeof url === "string") return url;
      return enabled === false ? "paused" : { url, secret };
    } catch {
      return "config-unavailable";
    }
  }

  async function status(): Promise<NotificationConfigStatus> {
    const target = await destination();
    return typeof target === "string" ? target : "ready";
  }

  async function send({ title, lines, deduplicationKey }: StrategyNotification): Promise<NotificationDelivery> {
    const target = await destination();
    if (typeof target === "string") return target;
    const { url, secret } = target;

    const now = clock();
    const cutoff = now - RATE_WINDOW_MS;
    while (attempts.length && attempts[0] <= cutoff) attempts.shift();
    for (const [key, time] of recent) {
      if (time <= cutoff) recent.delete(key);
    }
    if (deduplicationKey && recent.has(deduplicationKey)) return "duplicate";
    if (attempts.length >= SEND_LIMIT) return "rate-limited";
    attempts.push(now);
    if (deduplicationKey) recent.set(deduplicationKey, now);

    const signingSecret = secret?.trim();
    if (signingSecret) {
      const timestamp = String(now);
      const sign = createHmac("sha256", signingSecret).update(`${timestamp}\n${signingSecret}`).digest("base64");
      url.searchParams.set("timestamp", timestamp);
      url.searchParams.set("sign", sign);
    }

    try {
      const response = await fetchWebhook(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: [`【CCXT】${title}`, ...lines].join("\n") } }),
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      });
      if (response.ok && (await response.json())?.errcode === 0) return "sent";
    } catch {
      // The fetch error may contain the signed Webhook URL.
    }
    if (deduplicationKey && recent.get(deduplicationKey) === now) recent.delete(deduplicationKey);
    return "failed";
  }

  return { status, send };
}

function readEnvironment(): Configuration {
  return {
    webhook: process.env.DINGTALK_WEBHOOK_URL,
    secret: process.env.DINGTALK_WEBHOOK_SECRET,
  };
}

export function localSettingsEnabled() {
  return process.env.PLAYGROUND_LOCAL_SETTINGS === "1";
}

export const dingTalkSettings = createDingTalkSettings(
  path.join(process.cwd(), ".cache", "strategy-notifications", "dingtalk.json"), readEnvironment,
);
export const strategyNotifier = createStrategyNotifier(() => localSettingsEnabled() ? dingTalkSettings.read() : readEnvironment());
