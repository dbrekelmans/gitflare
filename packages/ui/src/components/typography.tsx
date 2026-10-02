import type { ComponentProps, ElementType, ReactNode } from "react";
import { cx } from "../cx";

export type HeadingSize =
  | "display-xl"
  | "display-l"
  | "display-m"
  | "display-s"
  | "lede"
  | "statement"
  | "title";

const headingSizes: Record<HeadingSize, string> = {
  "display-xl": "type-display-xl",
  "display-l": "type-display-l",
  "display-m": "type-display-m",
  "display-s": "type-display-s",
  lede: "type-lede",
  statement: "type-statement",
  title: "type-title",
};

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const defaultSize: Record<HeadingLevel, HeadingSize> = {
  1: "display-s",
  2: "lede",
  3: "statement",
  4: "title",
  5: "title",
  6: "title",
};

export type HeadingProps = Omit<ComponentProps<"h1">, "children"> & {
  /** The document outline. Independent of how large the heading is set. */
  level?: HeadingLevel;
  size?: HeadingSize;
  children: ReactNode;
};

export function Heading({
  level = 2,
  size = defaultSize[level],
  className,
  ...props
}: HeadingProps) {
  const Tag = `h${level}` as const;
  return (
    <Tag
      className={cx(
        headingSizes[size],
        "text-ink on-flare:text-on-flare on-ink:text-on-ink",
        className,
      )}
      {...props}
    />
  );
}

export type TextSize =
  | "body-l"
  | "body-m"
  | "body"
  | "body-s"
  | "sm"
  | "ui"
  | "meta";

const textSizes: Record<TextSize, string> = {
  "body-l": "type-body-l",
  "body-m": "type-body-m",
  body: "type-body",
  "body-s": "type-body-s",
  sm: "type-sm",
  ui: "type-ui",
  meta: "type-meta",
};

export type Tone = "ink" | "muted" | "faint";

const tones: Record<Tone, string> = {
  ink: "text-ink on-flare:text-on-flare on-ink:text-on-ink",
  muted: "text-muted on-flare:text-on-flare-body on-ink:text-faint-inverse",
  faint: "text-faint on-flare:text-on-flare-body on-ink:text-faint-inverse",
};

export type TextProps = Omit<ComponentProps<"p">, "children"> & {
  as?: ElementType;
  size?: TextSize;
  tone?: Tone;
  children: ReactNode;
};

/** Anything a person wrote. Set in the display face, never in mono. */
export function Text({
  as: Tag = "p",
  size = "body",
  tone = "ink",
  className,
  ...props
}: TextProps) {
  return (
    <Tag className={cx(textSizes[size], tones[tone], className)} {...props} />
  );
}

/**
 * - `id`: the identifying line, 500 in ink.
 * - `payload`: what the machine recorded, 400 muted.
 * - `note`: an annotation that stays unread until wanted, 400 faint.
 */
export type EvidenceKind = "id" | "payload" | "note";

const evidenceKinds: Record<EvidenceKind, string> = {
  id: "font-medium text-ink on-flare:text-on-flare on-ink:text-on-ink",
  payload: "text-muted on-flare:text-on-flare-body on-ink:text-faint-inverse",
  note: "text-faint on-flare:text-on-flare-body on-ink:text-faint-inverse",
};

export type EvidenceSize = "md" | "sm" | "xs";

const evidenceSizes: Record<EvidenceSize, string> = {
  md: "type-mono",
  sm: "type-mono-sm",
  xs: "type-mono-xs",
};

export type EvidenceProps = Omit<ComponentProps<"span">, "children"> & {
  as?: ElementType;
  kind?: EvidenceKind;
  size?: EvidenceSize;
  children: ReactNode;
};

/**
 * A line a machine authored or verified: an intent record, provenance, a
 * verification result, commit metadata. Mono is a claim about authorship, so
 * this is the only primitive that reaches for it; a sentence a person wrote
 * goes in `Text`.
 */
export function Evidence({
  as: Tag = "span",
  kind = "payload",
  size = "md",
  className,
  ...props
}: EvidenceProps) {
  return (
    <Tag
      className={cx(evidenceSizes[size], evidenceKinds[kind], className)}
      {...props}
    />
  );
}

export type TextLinkProps = ComponentProps<"a"> & {
  /** `quiet` is the escape hatch: available, not offered. */
  tone?: "ink" | "quiet";
};

export function TextLink({ tone = "ink", className, ...props }: TextLinkProps) {
  return (
    <a
      className={cx(
        "type-meta cursor-pointer decoration-1 underline-offset-[3px] outline-offset-2 outline-ink focus-visible:outline-[1.5px]",
        tone === "ink"
          ? "text-ink underline on-flare:text-on-flare"
          : "text-muted hover:text-ink hover:underline on-flare:text-on-flare-body on-flare:hover:text-on-flare",
        className,
      )}
      {...props}
    />
  );
}
