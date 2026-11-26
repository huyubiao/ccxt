import { useLayoutEffect, useState, type ToggleEvent } from "react";

export function useRememberedDetails(section: string) {
  const key = `ccxt-markets-details:${section}`;
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    try {
      setOpen(localStorage.getItem(key) === "true");
    } catch { /* Keep the default when storage is unavailable. */ }
  }, [key]);

  function onToggle(event: ToggleEvent<HTMLDetailsElement>) {
    if (event.target !== event.currentTarget) return;
    const next = event.currentTarget.open;
    if (next === open) return;
    setOpen(next);
    try {
      localStorage.setItem(key, String(next));
    } catch { /* Keep the session setting. */ }
  }

  return { open, onToggle };
}
