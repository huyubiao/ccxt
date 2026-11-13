"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import {
  FORECAST_HISTORY_LIMIT, FORECAST_VERSION, MAX_FORECAST_AGE_MS, forecastAlertMove, getRecordForecast,
  type ForecastAnalysis, type ForecastOutcome, type ForecastRecord,
} from "@/lib/spike-forecast";

const STORAGE_KEY = `ccxt-spike-forecasts-v${FORECAST_VERSION}`;
const SETTLEMENT_RETRY_MS = 30_000;

const keyOf = ({ symbol, time }: ForecastRecord) => `${symbol}:${time}`;

function loadHistory(): ForecastRecord[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((row) => row && typeof row.symbol === "string" &&
      Number.isSafeInteger(row.time) && Number.isFinite(row.change)).slice(0, FORECAST_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function requestForecast<T>(params: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(`/api/markets/alert-forecast?${params}`), {
    cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  });
  if (!response.ok) throw new Error("Forecast data unavailable.");
  return response.json();
}

export function useSpikeForecasts() {
  const [records, setRecords] = useState<ForecastRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(0);
  const lifecycle = useRef<AbortController | null>(null);
  const running = useRef(new Map<string, "analysis" | "outcome">());
  const nextRetry = useRef(new Map<string, number>());
  const hasPending = records.some((row) => row.analysis === undefined || (!!getRecordForecast(row) && row.outcome === undefined));

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setRecords(loadHistory());
    setReady(true);
    const jobs = running.current;
    const retries = nextRetry.current;
    return () => { controller.abort(); jobs.clear(); retries.clear(); };
  }, []);

  useEffect(() => {
    if (ready) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { /* Keep the current session history. */ }
    }
  }, [records, ready]);

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setClock(Date.now()), 3000);
    return () => clearInterval(timer);
  }, [hasPending]);

  useEffect(() => {
    const signal = lifecycle.current?.signal;
    if (!ready || !signal || signal.aborted) return;
    const now = Date.now();
    const jobs = running.current;
    const retries = nextRetry.current;
    const activeKeys = new Set(records.map(keyOf));
    for (const key of retries.keys()) if (!activeKeys.has(key)) retries.delete(key);
    let analysisSlots = 2, outcomeSlots = 2;
    for (const job of jobs.values()) {
      if (job === "analysis") analysisSlots--;
      else outcomeSlots--;
    }
    const expired = new Set<string>();

    function update(key: string, patch: Partial<ForecastRecord>) {
      setRecords((previous) => previous.map((row) => keyOf(row) === key ? { ...row, ...patch } : row));
    }

    for (const row of records) {
      const key = keyOf(row);
      if (jobs.has(key)) continue;
      if (row.analysis === undefined) {
        if (now - row.time > MAX_FORECAST_AGE_MS) {
          expired.add(key);
        } else if (analysisSlots > 0) {
          analysisSlots--;
          jobs.set(key, "analysis");
          const params = new URLSearchParams({ symbol: row.symbol, time: String(row.time), change: String(row.change) });
          void requestForecast<ForecastAnalysis>(params, signal).catch(() => null).then((analysis) => {
            if (signal.aborted) return;
            jobs.delete(key);
            update(key, { analysis });
          });
        }
        continue;
      }

      const forecast = getRecordForecast(row);
      if (!forecast || row.outcome !== undefined || outcomeSlots <= 0 || now < forecast.settlesAt + 2000 ||
          now < (retries.get(key) ?? 0)) continue;
      outcomeSlots--;
      jobs.set(key, "outcome");
      const params = new URLSearchParams({ symbol: row.symbol, settlesAt: String(forecast.settlesAt) });
      void requestForecast<{ outcome: ForecastOutcome | null }>(params, signal).then(({ outcome }) => {
        if (signal.aborted) return;
        retries.delete(key);
        update(key, { outcome });
      }).catch(() => {
        if (!signal.aborted) retries.set(key, Date.now() + SETTLEMENT_RETRY_MS);
      }).finally(() => {
        if (!signal.aborted) jobs.delete(key);
      });
    }
    if (expired.size) {
      setRecords((previous) => previous.map((row) => expired.has(keyOf(row)) ? { ...row, analysis: null } : row));
    }
  }, [records, ready, clock]);

  const addAlerts = useCallback((batch: (Pick<ForecastRecord, "symbol" | "time" | "change"> & { price: number })[]) => {
    setRecords((previous) => {
      const unique = new Map<string, ForecastRecord>();
      for (const { symbol, time, change, price } of batch) {
        const candidate = { symbol, time, change, fallback: forecastAlertMove(change, price, time) };
        const key = keyOf(candidate);
        if (Math.abs(change) > Math.abs(unique.get(key)?.change ?? 0)) unique.set(key, candidate);
      }
      return [...unique.values(), ...previous].slice(0, FORECAST_HISTORY_LIMIT);
    });
  }, []);

  return { records, addAlerts };
}
