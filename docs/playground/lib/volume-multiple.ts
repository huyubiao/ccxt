export const VOLUME_BASELINE_DAYS = 180;
const DAY = 86_400_000;

export function selectVolumeMultiple(rows: [number, number][], asOf: number, onboardAt: number) {
  const latestDay = Math.floor(asOf / DAY) * DAY - DAY;
  const start = Math.max(latestDay - VOLUME_BASELINE_DAYS * DAY, Math.ceil(onboardAt / DAY) * DAY);
  const days = (latestDay - start) / DAY;
  if (days < 1) return null;

  const volumes = new Map(rows.filter(([, volume]) => Number.isFinite(volume) && volume >= 0));
  const latest = volumes.get(latestDay);
  if (latest === undefined) return null;
  let total = 0;
  for (let time = start; time < latestDay; time += DAY) {
    const volume = volumes.get(time);
    if (volume === undefined) return null;
    total += volume;
  }
  const average = total / days;
  if (!Number.isFinite(average) || average <= 0) return null;
  const multiple = latest / average;
  return Number.isFinite(multiple) ? multiple : null;
}
