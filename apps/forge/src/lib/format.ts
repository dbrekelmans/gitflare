import type { MicroUsd, Sha, Timestamp } from "@gitflare/core";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(amount: MicroUsd): string {
  return usd.format(amount / 1_000_000);
}

export function shortSha(sha: Sha): string {
  return sha.slice(0, 7);
}

const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** A fixed, zone-free rendering, so the server and the browser print the same text. */
export function formatTime(at: Timestamp): string {
  return `${dateTime.format(at)} UTC`;
}
