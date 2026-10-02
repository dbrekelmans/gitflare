import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { focusRing } from "#lib/styles"
import { cn } from "#lib/utils"

/** Pressed is ink, not flare: a toggle is a view filter, not an action. */
const toggleVariants = cva(
  cn(
    "group/toggle inline-flex cursor-pointer items-center justify-center gap-s2 rounded-pill font-medium whitespace-nowrap text-ink transition-colors hover:bg-surface active:bg-press data-pressed:bg-ink data-pressed:text-on-ink data-disabled:pointer-events-none data-disabled:text-faint data-disabled:data-pressed:bg-surface [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    focusRing
  ),
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-[1.5px] border-border data-pressed:border-ink",
      },
      size: {
        default: "px-s7 py-[11px] text-ui leading-ui",
        sm: "px-s5 py-[7px] text-detail leading-xs",
        lg: "px-s8 py-[14px] text-body-m leading-ui",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
