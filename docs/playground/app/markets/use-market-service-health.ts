"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";

const endpoint = apiUrl("/api/markets/health");
const POLL_MS = 4_000;

export type MarketServiceHealth = {
  state: "checking" | "online" | "unavailable";
  lastResponse: number | null;
};

export function useMarketServiceHealth() {
  const [health, setHealth] = useState<MarketServiceHealth>({ state: "checking", lastResponse: null });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        });
        if (response.status !== 204) throw new Error("Health check failed");
        const lastResponse = Date.now();
        if (!controller.signal.aborted) setHealth({ state: "online", lastResponse });
      } catch {
        if (!controller.signal.aborted) setHealth((previous) => ({ ...previous, state: "unavailable" }));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, POLL_MS);
    }

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return health;
}
