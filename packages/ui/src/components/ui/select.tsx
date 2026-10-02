"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Check, ChevronDown } from "#components/icons"
import { menuItem, panel, popupMotion } from "#lib/styles"
import { cn } from "#lib/utils"

const Select = SelectPrimitive.Root

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-s2", className)}
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    />
  )
}

/**
 * Closed, a select is an input with a chevron: the same rule, thickening to
 * 1.5px ink on focus. `framed` is for overlays and table filters.
 */
function SelectTrigger({
  className,
  variant = "underline",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  variant?: "underline" | "framed"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-s5 bg-transparent whitespace-nowrap text-ink outline-none transition-colors select-none data-placeholder:text-faint data-disabled:cursor-not-allowed data-disabled:text-faint *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-s2",
        variant === "underline"
          ? "border-b border-rule pb-[11px] text-body leading-body-s focus-visible:border-b-[1.5px] focus-visible:border-ring focus-visible:pb-[10.5px] aria-invalid:border-b-[1.5px] aria-invalid:border-flare-deep aria-invalid:pb-[10.5px] data-popup-open:border-b-[1.5px] data-popup-open:border-ring data-popup-open:pb-[10.5px]"
          : "rounded-chip border-[1.5px] border-input px-[14px] py-[11px] text-ui leading-body-s focus-visible:border-ring aria-invalid:border-flare-deep data-popup-open:border-ring",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDown className="pointer-events-none text-muted-foreground group-data-placeholder:text-faint" />
        }
      />
    </SelectPrimitive.Trigger>
  )
}

/** Open, a select is the overlay panel carrying options. */
function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 8,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = false,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-48 origin-(--transform-origin) overflow-x-hidden overflow-y-auto py-s2 data-[align-trigger=true]:animate-none",
            panel,
            popupMotion,
            className
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn(
        "type-detail px-s5 py-s2 text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        menuItem,
        "justify-between gap-s5",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-s2 whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={<span className="pointer-events-none flex items-center" />}
      >
        <Check />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none my-s2 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-s1 text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-s1 text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
