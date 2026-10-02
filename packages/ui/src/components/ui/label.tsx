import * as React from "react"
import { cn } from "#lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-s2 text-detail leading-ui font-medium text-ink select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-faint peer-disabled:cursor-not-allowed peer-disabled:text-faint",
        className
      )}
      {...props}
    />
  )
}

export { Label }
