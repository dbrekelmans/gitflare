import type { CloudSessionState } from "@gitflare/core";
import type { StatusTone } from "@gitflare/ui/components/status";

// What the page says about a session's state. Kept apart from the
// components so the wording is in one place, as in the change page.

export const cloudStateCopy: Record<CloudSessionState, { label: string; tone: StatusTone }> = {
  starting: { label: "Starting", tone: "neutral" },
  idle: { label: "Waiting for a prompt", tone: "flare" },
  working: { label: "Working", tone: "neutral" },
  asleep: { label: "Asleep", tone: "neutral" },
  ended: { label: "Ended", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export const sessionStatusCopy: Record<"active" | "merged" | "abandoned", StatusTone> = {
  active: "neutral",
  merged: "success",
  abandoned: "neutral",
};
