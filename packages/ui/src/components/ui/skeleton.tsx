import { cn } from "#lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-[8px] bg-border-disabled motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
