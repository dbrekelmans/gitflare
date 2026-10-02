import type { ReactNode } from "react";
import { Evidence, Heading, Text } from "#components/typography";
import { cn } from "#lib/utils";

/** A section opener: the statement on the left, what backs it on the right. */
export function Statement({
  title,
  children,
  pad = "pb-s10",
}: {
  title: ReactNode;
  children: ReactNode;
  pad?: "pb-s10" | "pb-[40px]" | "pb-[36px]";
}) {
  return (
    <div className={cn("flex items-end gap-s17 border-t border-rule pt-s9", pad)}>
      <Heading level={2} size="display-s" className="w-claim shrink-0">
        {title}
      </Heading>
      <Text size="body-m" tone="muted" className="w-support shrink-0">
        {children}
      </Text>
    </div>
  );
}

/** A primitive's sheet: its name, what it is for, then lanes of examples. */
export function Sheet({
  title,
  children,
  lede,
}: {
  title: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="px-s13 pt-s13 pb-s10">
      <div className="flex items-end gap-s17 pb-[36px]">
        <Heading level={3} size="display-s" className="w-claim shrink-0">
          {title}
        </Heading>
        <Text tone="muted" className="w-support shrink-0">
          {lede}
        </Text>
      </div>
      {children}
    </section>
  );
}

export function Lane({
  label,
  note,
  center = false,
  children,
}: {
  label: string;
  note?: ReactNode;
  center?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex gap-s11 pb-s10", center ? "items-center" : "items-start")}>
      <Text size="detail" tone="muted" className="w-lane shrink-0">
        {label}
      </Text>
      <div className="min-w-0 flex-1">{children}</div>
      {note != null && <Note className="w-annotation shrink-0">{note}</Note>}
    </div>
  );
}

/** A measurement, read off the theme or the primitive. */
export function Note({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Evidence
      as="div"
      kind="note"
      size="xs"
      className={cn("leading-mono whitespace-pre-line", className)}
    >
      {children}
    </Evidence>
  );
}
