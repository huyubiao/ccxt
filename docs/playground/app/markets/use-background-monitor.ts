"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { BackgroundMonitorStatus, BackgroundRule } from "@/lib/background-monitor-types";
import { readMarketResponse } from "@/lib/market-response";

const endpoint = apiUrl("/api/markets/background-monitor");

export function useBackgroundMonitor() {
  const [mode, setMode] = useState<"loading" | "local" | "browser">("loading");
  const [data, setData] = useState<BackgroundMonitorStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const updating = useRef(false);

  useEffect(() => {
    if (mode === "browser" || saving) return;
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
        const status = await readMarketResponse<BackgroundMonitorStatus>(response, "无法读取异动监控状态。");
        if (request.signal.aborted) return;
        if (!updating.current) {
          setMode("local");
          setData(status);
          setReadError("");
        }
      } catch (error) {
        if (!request.signal.aborted && !updating.current) {
          setReadError(error instanceof Error ? error.message : "无法读取异动监控状态。");
        }
      }
      if (!request.signal.aborted) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [mode, saving]);

  async function save(rule: BackgroundRule) {
    if (updating.current) return;
    updating.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rule),
        signal: AbortSignal.timeout(10_000),
      });
      setData(await readMarketResponse<BackgroundMonitorStatus>(response, "无法保存异动监控设置。"));
      setReadError("");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "无法保存异动监控设置。");
    } finally {
      updating.current = false;
      setSaving(false);
    }
  }

  return { mode, data, saving, error: saveError || readError, save };
}
