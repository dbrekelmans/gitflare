import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "#lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-s7 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

/**
 * Tabs sit on a hairline. The active tab is ink with a 2px ink rule under
 * it: no pill, no fill, no flare. A count beside a tab label is machine
 * content, so pass it as `Evidence`.
 */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "group/tabs-list flex border-rule group-data-horizontal/tabs:items-end group-data-horizontal/tabs:gap-[26px] group-data-horizontal/tabs:border-b group-data-vertical/tabs:flex-col group-data-vertical/tabs:gap-s2 group-data-vertical/tabs:border-l",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex cursor-pointer items-center gap-s2 border-transparent px-[2px] text-body leading-[20px] whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-ink focus-visible:outline-solid focus-visible:outline-[1.5px] focus-visible:outline-offset-4 focus-visible:outline-ring data-active:border-ink data-active:font-medium data-active:text-ink data-disabled:pointer-events-none data-disabled:text-faint group-data-horizontal/tabs:-mb-px group-data-horizontal/tabs:border-b-2 group-data-horizontal/tabs:pb-[11px] group-data-vertical/tabs:-ml-px group-data-vertical/tabs:border-l-2 group-data-vertical/tabs:py-[6px] group-data-vertical/tabs:pl-s5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
