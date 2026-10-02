import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "#lib/utils"

import { Button } from "#components/ui/button"
import { Input } from "#components/ui/input"
import { Textarea } from "#components/ui/textarea"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex w-full min-w-0 items-center gap-s3 rounded-chip border-[1.5px] border-input px-[14px] py-[11px] transition-colors outline-none has-disabled:bg-surface has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-flare-deep has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:items-stretch has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:items-stretch",
        className
      )}
      {...props}
    />
  )
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-s2 text-detail leading-body-s text-faint select-none [&>svg:not([class*='size-'])]:size-[14px]",
  {
    variants: {
      align: {
        "inline-start":
          "order-first",
        "inline-end":
          "order-last has-[>button]:-my-[5px] has-[>button]:-mr-[8px]",
        "block-start":
          "order-first w-full justify-start",
        "block-end":
          "order-last w-full justify-start",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  }
)

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus()
      }}
      {...props}
    />
  )
}

const inputGroupButtonVariants = cva(
  "flex items-center gap-s2",
  {
    variants: {
      size: {
        xs: "px-s4 py-[5px] text-xs leading-xs",
        sm: "",
        "icon-xs":
          "size-[28px] p-0",
        "icon-sm": "size-[34px] p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  }
)

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset"
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  )
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-s2 text-detail leading-body-s text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-[14px]",
        className
      )}
      {...props}
    />
  )
}

function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 p-0 text-ui leading-body-s focus-visible:border-0 focus-visible:pb-0 aria-invalid:border-0 aria-invalid:pb-0",
        className
      )}
      {...props}
    />
  )
}

function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 p-0 text-ui leading-body-s focus-visible:border-0 focus-visible:pb-0 aria-invalid:border-0 aria-invalid:pb-0",
        className
      )}
      {...props}
    />
  )
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
}
