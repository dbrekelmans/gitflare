import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "#lib/utils"

/**
 * A tinted pill. Badges are never solid: a filled flare badge would be a
 * second primary action. `default` is flare ("this is waiting on you");
 * `secondary` is the neutral one for everything that needs no attention.
 * For a status with its dot, use `StatusPill` from `components/status`.
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-s2 overflow-hidden rounded-pill border-[1.5px] border-transparent px-[12.5px] py-[4.5px] text-detail leading-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-solid focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-ring [&>svg]:pointer-events-none [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-flare-tint text-flare-deep",
        secondary: "bg-surface text-muted-foreground",
        success: "bg-success-tint text-success-deep",
        warning: "bg-warning-tint text-warning-deep",
        destructive: "bg-danger-tint text-danger-deep",
        outline: "border-border text-ink",
        ghost: "text-muted-foreground [a]:hover:bg-surface [a]:hover:text-ink",
        link: "text-ink underline decoration-1 underline-offset-[3px]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
