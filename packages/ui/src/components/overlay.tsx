import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cx } from "../cx";

// One overlay surface exists in this system. Popover, menu and dialog share it.
const panel =
  "rounded-panel border-[1.5px] border-border bg-ground shadow-floating";

/**
 * A floating panel carrying content. No arrow or tail: the shadow already
 * says it floats. Small buttons only. Placement is the caller's; pass
 * `popover` and an `id` to use the platform's popover behaviour.
 */
export function Popover({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx(panel, "flex w-full max-w-aside flex-col gap-[14px] p-6", className)}
      {...props}
    />
  );
}

/** The same panel carrying options: what an open select is. */
export function Menu({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="listbox"
      className={cx(panel, "flex w-full max-w-aside flex-col py-2", className)}
      {...props}
    />
  );
}

export type MenuItemProps = ComponentProps<"button"> & {
  selected?: boolean;
  /** For the option that opts out: "Never verify". */
  quiet?: boolean;
};

export function MenuItem({
  selected = false,
  quiet = false,
  className,
  children,
  ...props
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={cx(
        "type-body-s flex w-full cursor-pointer items-center justify-between gap-5 px-5 py-3 text-left outline-none hover:bg-surface focus-visible:bg-surface disabled:cursor-not-allowed disabled:text-faint",
        quiet ? "text-muted" : "text-ink",
        selected && "bg-surface",
        className,
      )}
      {...props}
    >
      {children}
      {selected && (
        <svg
          width="13"
          height="10"
          viewBox="0 0 13 10"
          aria-hidden="true"
          className="shrink-0 stroke-ink"
        >
          <path
            d="M1 5 L4.5 8.4 L12 1"
            fill="none"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

export function MenuSeparator({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="separator"
      className={cx("my-2 h-px shrink-0 bg-border", className)}
      {...props}
    />
  );
}

export type DialogProps = Omit<ComponentProps<"dialog">, "open"> & {
  open: boolean;
  /** `false` renders the dialog in the page flow, without the scrim. */
  modal?: boolean;
  children: ReactNode;
};

/**
 * The question card, promoted. It asks about intent; it never asks you to
 * confirm what the machine already verified. Three bands: `DialogHead`,
 * `DialogBody`, `DialogFoot`.
 */
export function Dialog({
  open,
  modal = true,
  className,
  ...props
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !modal) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, modal]);

  return (
    <dialog
      ref={ref}
      open={modal ? undefined : open}
      className={cx(
        "w-[600px] max-w-[calc(100vw-2*var(--spacing-7))] flex-col overflow-clip rounded-card bg-ground text-ink shadow-floating backdrop:bg-scrim open:flex",
        modal ? "m-auto" : "static",
        className,
      )}
      {...props}
    />
  );
}

/** A mono breadcrumb on the left, a status on the right. */
export function DialogHead({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cx(
        "flex items-center justify-between gap-7 border-b border-border px-8 py-5",
        className,
      )}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("flex flex-col gap-5 p-8", className)} {...props} />;
}

/**
 * The recommendation sits opposite the actions rather than beneath them, so
 * the dialog closes on a single line of reading.
 */
export function DialogFoot({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cx(
        "flex items-center justify-between gap-7 border-t border-border bg-surface px-8 py-6",
        className,
      )}
      {...props}
    />
  );
}
