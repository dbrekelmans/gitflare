"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { focusRing } from "#lib/styles"
import { cn } from "#lib/utils"

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-s6", className)}
      {...props}
    />
  )
}

/** One out of many. The checkbox's box taken to a full circle, in ink. */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "group/radio-group-item peer relative flex size-(--container-control) shrink-0 cursor-pointer items-center justify-center rounded-pill border-[1.5px] border-border transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 data-checked:border-ink data-checked:bg-ink data-disabled:cursor-not-allowed data-disabled:border-rule data-disabled:bg-surface aria-invalid:border-flare-deep",
        focusRing,
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="size-[6px] rounded-pill bg-on-ink"
      />
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem }
