import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { type VariantProps } from "class-variance-authority"

import { toggleVariants } from "#components/ui/toggle"
import { cn } from "#lib/utils"

const ToggleGroupContext = React.createContext<
  Pick<VariantProps<typeof toggleVariants>, "size">
>({ size: "default" })

/**
 * The segmented control. Segments share one outline and one hairline
 * between them; the selected segment is ink even where the primary button
 * is flare, because a group filters a view rather than acting on it.
 */
function ToggleGroup({
  className,
  size = "default",
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  Pick<VariantProps<typeof toggleVariants>, "size">) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-size={size}
      className={cn(
        "group/toggle-group flex w-fit items-stretch overflow-clip rounded-pill border-[1.5px] border-border data-disabled:border-border-disabled data-[orientation=vertical]:flex-col data-[orientation=vertical]:rounded-panel",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  size,
  ...props
}: TogglePrimitive.Props & Pick<VariantProps<typeof toggleVariants>, "size">) {
  const context = React.useContext(ToggleGroupContext)
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        toggleVariants({ variant: "default", size: size ?? context.size }),
        // The focus outline sits inside the segment, so the group's clip does not cut it.
        "shrink-0 rounded-none border-border focus-visible:-outline-offset-[5px] data-pressed:focus-visible:outline-on-ink group-data-[orientation=horizontal]/toggle-group:not-first:border-l group-data-[orientation=vertical]/toggle-group:not-first:border-t group-data-disabled/toggle-group:border-border-disabled",
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
