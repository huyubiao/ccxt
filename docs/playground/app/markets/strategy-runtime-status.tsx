"use client";

import type { useBackgroundMonitor } from "./use-background-monitor";
import type { MarketServiceHealth } from "./use-market-service-health";
import styles from "./markets.module.css";

type Props = {
  health: MarketServiceHealth;
  background: Pick<ReturnType<typeof useBackgroundMonitor>, "mode" | "data" | "readError">;
  browser: { enabled: boolean; receiving: boolean };
};

type Status = { label: string; tone?: "good" | "wait" | "error" };
const checking: Status = { label: "检测中" };
const unknown: Status = { label: "状态未知", tone: "wait" };
const stopped: Status = { label: "已停止" };
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium", hour12: false });

export default function StrategyRuntimeStatus({ health, background, browser }: Props) {
  const service: Status = health.state === "online" ? { label: "可访问", tone: "good" }
    : health.state === "unavailable" ? { label: "无法连接 · 重试中", tone: "error" } : checking;
  const { mode, data, readError } = background;
  let monitor = checking;

  if (mode === "browser") {
    monitor = !browser.enabled ? stopped : browser.receiving ? { label: "运行中 · 浏览器", tone: "good" }
      : { label: "等待行情 · 浏览器", tone: "wait" };
  } else if (health.state === "unavailable" || readError) {
    monitor = unknown;
  } else if (health.state === "online" && mode === "local" && data) {
    if (!data.rule.enabled) monitor = stopped;
    else if (data.worker === "connected") monitor = { label: "运行中 · 后台", tone: "good" };
    else if (data.worker === "offline") monitor = { label: "监控进程离线", tone: "error" };
    else monitor = { label: "等待行情 · 后台", tone: "wait" };
  }

  const rows = [
    ["Rust 行情服务", service],
    ["异动监控策略", monitor],
    ["测试策略", { label: "手动触发" }],
  ] as const;

  return (
    <section className={styles.strategyRuntime} aria-labelledby="strategy-runtime-heading">
      <h3 id="strategy-runtime-heading">运行状态</h3>
      <dl aria-live="polite">
        {rows.map(([name, status]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd data-tone={"tone" in status ? status.tone : undefined}>{status.label}</dd>
          </div>
        ))}
      </dl>
      {health.lastResponse !== null && <p>
        Rust 服务最近响应于 <time dateTime={new Date(health.lastResponse).toISOString()}>{timeFormat.format(health.lastResponse)}</time>
      </p>}
    </section>
  );
}
