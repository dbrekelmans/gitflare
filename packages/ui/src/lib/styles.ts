/** Keyboard focus is a 1.5px ink outline, never a glow. */
export const focusRing =
  "outline-none focus-visible:outline-solid focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-ring"

/**
 * The overlay surface that popover, menu, select and tooltip-free panels
 * share. Transient overlays carry the shadow; nothing in page flow does
 * except the floating card.
 */
export const panel =
  "rounded-panel border-[1.5px] border-border bg-popover text-popover-foreground shadow-floating outline-none"

/** Overlays fade; they do not zoom or slide. */
export const popupMotion =
  "duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none"

export const menuItem =
  "type-body-s relative flex w-full cursor-default items-center gap-s2 px-s5 py-s3 text-ink outline-none select-none focus:bg-press data-highlighted:bg-press data-disabled:pointer-events-none data-disabled:text-faint [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
