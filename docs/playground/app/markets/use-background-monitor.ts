"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { BackgroundMonitorStatus, BackgroundRule } from "@/lib/background-monitor-types";
import { readMarketResponse } from "@/lib/market-response";
import type { SpikeIdentity } from "@/lib/price-alerts";

const endpoint = apiUrl("/api/markets/background-monitor");
type UpdateRule = BackgroundRule & { accountRevision?: string };
type UpdateBody = UpdateRule | readonly SpikeIdentity[];

export function useBackgroundMonitor() {
  const [mode, setMode] = useState<"loading" | "local" | "browser">("loading");
  const [data, setData] = useState<BackgroundMonitorStatus | null>(null);
  const [mutation, setMutation] = useState<"PUT" | "DELETE" | null>(null);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const updating = useRef(false);

  useEffect(() => {
    if (mode === "browser" || mutation) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
        });
        if (request.signal.aborted) return;
        if (response.status === 403) {
          setMode("browser");
          setReadError("");
          return;
        }
        const status = await readMarketResponse<BackgroundMonitorStatus>(response, "无法读取异动监控策略状态。");
        if (request.signal.aborted) return;
        if (!updating.current) {
          setMode("local");
          setData(status);
          setReadError("");
        }
      } catch (error) {
        if (!request.signal.aborted && !updating.current) {
          setReadError(error instanceof Error ? error.message : "无法读取异动监控策略状态。");
        }
      }
      if (!request.signal.aborted) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [mode, mutation]);

  async function update(method: "PUT" | "DELETE", body: UpdateBody, message: string) {
    if (updating.current) throw new Error("另一项后台监控操作正在进行，请稍后重试。");
    updating.current = true;
    setMutation(method);
    try {
      const response = await fetch(endpoint, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      setData(await readMarketResponse<BackgroundMonitorStatus>(response, message));
      setReadError("");
    } finally {
      updating.current = false;
      setMutation(null);
    }
  }

  async function save(rule: UpdateRule) {
    if (updating.current) return;
    setSaveError("");
    const message = "无法保存异动监控策略设置。";
    try {
      await update("PUT", rule, message);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : message);
    }
  }

  function deleteSpikes(records: readonly SpikeIdentity[]) {
    return update("DELETE", records, "无法删除告警记录。");
  }

  return { mode, data, saving: mutation === "PUT", deleting: mutation === "DELETE", error: saveError || readError, readError,
    save, deleteSpikes };
}
