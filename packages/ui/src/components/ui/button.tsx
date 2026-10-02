import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { focusRing } from "#lib/styles"
import { cn } from "#lib/utils"

const filledDisabled =
  "data-disabled:bg-surface data-disabled:text-faint on-flare:data-disabled:bg-on-flare-fill on-flare:data-disabled:text-on-flare-muted"
const outlineDisabled =
  "data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:text-faint"
const ghostDisabled = "data-disabled:bg-transparent data-disabled:text-faint"

const buttonVariants = cva(
  cn(
    "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-s2 rounded-pill font-medium whitespace-nowrap transition-colors select-none data-disabled:pointer-events-none on-flare:focus-visible:outline-on-flare [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    focusRing
  ),
  {
    variants: {
      variant: {
        default: "",
        flare: cn(
          "bg-primary text-primary-foreground hover:bg-flare-deep active:bg-flare-shade",
          "on-flare:bg-on-flare on-flare:text-ink on-flare:hover:bg-flare-tint on-flare:active:bg-on-flare-press on-flare:active:text-flare-shade",
          filledDisabled
        ),
        outline: "border-[1.5px]",
        secondary: "border-[1.5px]",
        ghost: "",
        destructive: cn(
          "bg-destructive text-destructive-foreground hover:bg-danger-deep active:bg-danger-press",
          filledDisabled
        ),
        link: "rounded-none text-ink underline decoration-1 underline-offset-[3px] data-disabled:text-faint on-flare:text-on-flare",
      },
      tone: {
        neutral: "",
        success: "",
        warning: "",
        danger: "",
      },
      size: {
        default: "px-s7 py-[11px] text-ui leading-ui",
        xs: "px-s4 py-[5px] text-xs leading-xs",
        sm: "px-s5 py-[7px] text-detail leading-xs",
        lg: "px-s8 py-[14px] text-body-m leading-ui",
        icon: "size-10",
        "icon-xs": "size-[28px]",
        "icon-sm": "size-[34px]",
        "icon-lg": "size-[46px]",
      },
    },
    compoundVariants: [
      {
        variant: "default",
        tone: "neutral",
        class: cn(
          "bg-ink text-on-ink hover:bg-ink-hover active:bg-ink-press",
          filledDisabled
        ),
      },
      {
        variant: "default",
        tone: "success",
        class: cn(
          "bg-success text-on-success hover:bg-success-deep active:bg-success-press",
          filledDisabled
        ),
      },
      {
        variant: "default",
        tone: "warning",
        class: cn(
          "bg-warning text-on-warning hover:bg-warning-deep active:bg-warning-press",
          filledDisabled
        ),
      },
      {
        variant: "default",
        tone: "danger",
        class: cn(
          "bg-danger text-on-danger hover:bg-danger-deep active:bg-danger-press",
          filledDisabled
        ),
      },
      {
        variant: ["outline", "secondary"],
        tone: "neutral",
        class: cn(
          "border-border bg-background text-ink hover:border-rule hover:bg-surface active:border-border-press active:bg-press aria-expanded:bg-surface",
          "on-flare:border-on-flare-border on-flare:bg-transparent on-flare:text-on-flare on-flare:hover:border-on-flare-border-hover on-flare:hover:bg-on-flare-fill on-flare:active:border-on-flare-border-hover on-flare:active:bg-on-flare-fill-press",
          outlineDisabled,
          "on-flare:data-disabled:border-on-flare-fill-press on-flare:data-disabled:bg-transparent on-flare:data-disabled:text-on-flare-muted"
        ),
      },
      {
        variant: ["outline", "secondary"],
        tone: "success",
        class: cn(
          "border-success/35 text-success-deep hover:border-success/54 hover:bg-success-tint active:border-success active:bg-success-tint-press",
          outlineDisabled
        ),
      },
      {
        variant: ["outline", "secondary"],
        tone: "warning",
        class: cn(
          "border-warning/35 text-warning-deep hover:border-warning/54 hover:bg-warning-tint active:border-warning active:bg-warning-tint-press",
          outlineDisabled
        ),
      },
      {
        variant: ["outline", "secondary"],
        tone: "danger",
        class: cn(
          "border-danger/35 text-danger-deep hover:border-danger/54 hover:bg-danger-tint active:border-danger active:bg-danger-tint-press",
          outlineDisabled
        ),
      },
      {
        variant: "ghost",
        tone: "neutral",
        class: cn(
          "text-ink hover:bg-surface active:bg-press aria-expanded:bg-surface",
          "on-flare:text-on-flare on-flare:hover:bg-on-flare-fill on-flare:active:bg-on-flare-fill-press",
          ghostDisabled,
          "on-flare:data-disabled:bg-transparent on-flare:data-disabled:text-on-flare-muted"
        ),
      },
      {
        variant: "ghost",
        tone: "success",
        class: cn(
          "text-success-deep hover:bg-success-tint active:bg-success-tint-press",
          ghostDisabled
        ),
      },
      {
        variant: "ghost",
        tone: "warning",
        class: cn(
          "text-warning-deep hover:bg-warning-tint active:bg-warning-tint-press",
          ghostDisabled
        ),
      },
      {
        variant: "ghost",
        tone: "danger",
        class: cn(
          "text-danger-deep hover:bg-danger-tint active:bg-danger-tint-press",
          ghostDisabled
        ),
      },
      { variant: "link", class: "p-0" },
    ],
    defaultVariants: {
      variant: "default",
      tone: "neutral",
      size: "default",
    },
  }
)

/**
 * Two primaries, split by what the action is.
 *
 * - `default` is ink: a standing action that is always available (nav,
 *   toolbars, page headers).
 * - `flare` is a moment the system is waiting on: a dialog, a question, an
 *   inline decision. At most one flare button per view. On a flare field it
 *   turns white, because flare on flare stops reading as an action.
 * - `outline` is the secondary; `secondary` is an alias kept for shadcn
 *   blocks. `ghost` and `link` are the quiet ones.
 * - `tone` swaps ink for a status colour on `default`, `outline` and `ghost`.
 *   `destructive` is shorthand for a filled danger button. At most one
 *   status-toned button per view, and never on a flare field: status is
 *   semantic, not a second accent.
 */
function Button({
  className,
  variant = "default",
  tone = "neutral",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, tone, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
