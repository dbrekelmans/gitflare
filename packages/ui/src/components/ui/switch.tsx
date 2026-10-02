import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { focusRing } from "#lib/styles"
import { cn } from "#lib/utils"

/**
 * On or off, applied the moment you touch it. The one control that takes
 * flare, because it reports something live rather than staging a change.
 * Label left, switch right.
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-pill px-[3px] transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 data-[size=default]:h-[26px] data-[size=default]:w-[44px] data-[size=sm]:h-[20px] data-[size=sm]:w-[34px] data-checked:bg-primary data-unchecked:bg-rule data-disabled:cursor-not-allowed data-disabled:bg-surface motion-reduce:transition-none",
        focusRing,
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-pill bg-background transition-transform group-data-[size=default]/switch:size-[20px] group-data-[size=sm]/switch:size-[14px] group-data-[size=default]/switch:data-checked:translate-x-[18px] group-data-[size=sm]/switch:data-checked:translate-x-[14px] data-unchecked:translate-x-0 motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
