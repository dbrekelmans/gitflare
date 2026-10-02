import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "#lib/utils"

/**
 * A hairline. Rows and sections already carry their own top rule, so reach
 * for this only where nothing else owns the edge (inside a menu, between
 * toolbar groups).
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-rule data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
