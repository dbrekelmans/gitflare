import type { ComponentProps } from "react"
import { cn } from "#lib/utils"

/** Paper's own chevron and check: lighter and wider than an icon set's. */
export function ChevronDown({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      width="12"
      height="8"
      viewBox="0 0 12 8"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-auto shrink-0", className)}
      {...props}
    >
      <path d="M1 1.5 L6 6.5 L11 1.5" />
    </svg>
  )
}

export function Check({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      width="13"
      height="10"
      viewBox="0 0 13 10"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-auto shrink-0", className)}
      {...props}
    >
      <path d="M1 5 L4.5 8.4 L12 1" />
    </svg>
  )
}
