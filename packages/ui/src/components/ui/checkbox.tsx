import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { focusRing } from "#lib/styles"
import { cn } from "#lib/utils"

/**
 * Many out of many. It marks in ink, not flare: a checkbox almost always
 * arrives inside a list, where flare would shout.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox relative flex size-(--container-control) shrink-0 cursor-pointer items-center justify-center rounded-control border-[1.5px] border-border text-on-ink transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 data-checked:border-ink data-checked:bg-ink data-indeterminate:border-ink data-indeterminate:bg-ink data-disabled:cursor-not-allowed data-disabled:border-rule data-disabled:bg-surface aria-invalid:border-flare-deep",
        focusRing,
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current"
      >
        <svg
          width="11"
          height="8"
          viewBox="0 0 11 8"
          aria-hidden="true"
          className="group-data-indeterminate/checkbox:hidden"
        >
          <path
            d="M1 4 L4 6.8 L10 1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span
          aria-hidden="true"
          className="hidden h-[1.75px] w-s2 rounded-pill bg-current group-data-indeterminate/checkbox:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
