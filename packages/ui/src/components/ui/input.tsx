import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "#lib/utils"

/**
 * A field is a rule you type on: focus thickens that rule to 1.5px ink
 * rather than adding a glow, and the padding gives the half pixel back so
 * the text does not move. `framed` exists only inside overlays and table
 * filters, where there is no page ground to sit on.
 */
const inputVariants = cva(
  "w-full min-w-0 bg-transparent font-sans text-ink outline-none transition-colors placeholder:text-faint disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-faint file:inline-flex file:border-0 file:bg-transparent file:text-meta file:font-medium file:text-ink",
  {
    variants: {
      variant: {
        underline:
          "rounded-none border-0 border-b border-rule pb-[11px] text-body leading-body-s focus-visible:border-b-[1.5px] focus-visible:border-ring focus-visible:pb-[10.5px] aria-invalid:border-b-[1.5px] aria-invalid:border-flare-deep aria-invalid:pb-[10.5px]",
        framed:
          "rounded-chip border-[1.5px] border-input px-[14px] py-[11px] text-ui leading-body-s focus-visible:border-ring aria-invalid:border-flare-deep",
      },
    },
    defaultVariants: { variant: "underline" },
  }
)

function Input({
  className,
  type,
  variant = "underline",
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Input, inputVariants }
