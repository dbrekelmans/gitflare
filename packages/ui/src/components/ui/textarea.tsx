import * as React from "react"
import { cn } from "#lib/utils"

/** Grows to its content; the rule stays at the last line. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      rows={1}
      className={cn(
        "block field-sizing-content w-full resize-none rounded-none border-0 border-b border-rule bg-transparent pt-[2px] pb-s4 font-sans text-body leading-body-s text-ink outline-none transition-colors placeholder:text-faint focus-visible:border-b-[1.5px] focus-visible:border-ring focus-visible:pb-[11.5px] disabled:cursor-not-allowed disabled:text-faint aria-invalid:border-b-[1.5px] aria-invalid:border-flare-deep aria-invalid:pb-[11.5px]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
