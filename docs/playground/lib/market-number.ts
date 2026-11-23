import type { AlertVolume } from "./price-alerts";

const yi = { scale: 100_000_000, suffix: "亿" };
const wan = { scale: 10_000, suffix: "万" };

function marketUnit(value: number) {
  const magnitude = Math.abs(value);
  if (magnitude >= yi.scale) return yi;
  if (magnitude >= wan.scale) return wan;
}

export const fullMarketNumber = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 21 });

export function marketNumberFormatter(options: Intl.NumberFormatOptions = { maximumFractionDigits: 2 }) {
  const standard = new Intl.NumberFormat("zh-CN", options);
  const compact = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false, signDisplay: options.signDisplay,
  });

  return (value?: number | null) => {
    if (value == null || !Number.isFinite(value)) return "—";
    const unit = marketUnit(value);
    return unit ? `${compact.format(value / unit.scale)}${unit.suffix}` : standard.format(value);
  };
}

export const formatMarketAmount = marketNumberFormatter();

const formatMultiple = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });
const formatTurnoverWan = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, useGrouping: false });

export function formatAlertTurnover(volume?: AlertVolume, legacyMultiple?: number | null) {
  const multiple = volume?.multiple ?? legacyMultiple;
  if (multiple == null || !Number.isFinite(multiple) || multiple < 0) return null;
  const label = `成交额${formatMultiple.format(multiple)}倍`;
  const { baseline, turnover } = volume ?? {};
  if (baseline == null || !Number.isFinite(baseline) || baseline <= 0 ||
      turnover == null || !Number.isFinite(turnover) || turnover < 0) return label;
  return `${label}(${formatTurnoverWan.format(baseline / wan.scale)}万 -> ${formatTurnoverWan.format(turnover / wan.scale)}万)`;
}

export function formatMarketPriceRange(
  start: number, end: number, formatPrice: (value: number) => string, separator = " – ",
) {
  const from = formatPrice(start);
  const to = formatPrice(end);
  if (from !== to || start === end || !Number.isFinite(start) || !Number.isFinite(end)) {
    return `${from}${separator}${to}`;
  }
  return `${fullMarketNumber.format(start)}${separator}${fullMarketNumber.format(end)}`;
}
