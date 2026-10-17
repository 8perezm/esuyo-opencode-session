export function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.trunc(n));
}

export function fmtCost(c: number): string {
  if (c > 0 && c < 0.01) return "<$0.01";
  return "$" + c.toFixed(2);
}

export function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h" + String(minutes % 60).padStart(2, "0");
  return Math.floor(hours / 24) + "d" + String(hours % 24).padStart(2, "0") + "h";
}

export function fmtRate(percent: number): string {
  return percent.toFixed(1) + "%";
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + "…";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Failed to load session usage";
}
