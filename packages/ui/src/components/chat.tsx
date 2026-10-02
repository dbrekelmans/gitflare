import type { ComponentProps, FormEvent, ReactNode } from "react";
import { Children } from "react";
import { cn } from "#lib/utils"
import { InputGroup, InputGroupButton, InputGroupInput } from "#components/ui/input-group"

export type LineThreadProps = ComponentProps<"div"> & {
  /** `live` holds the thread with a flare rule; `settled` drops it to grey. */
  state?: "live" | "settled";
};

/**
 * A conversation pinned to a line of the diff. No card and no shadow: the
 * rule down the left is the whole container. Indent it to the code it
 * belongs to with a margin on `className`.
 */
export function LineThread({
  state = "live",
  className,
  ...props
}: LineThreadProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-[18px] border-l-2 py-[2px] pl-s6",
        state === "live" ? "border-flare" : "border-rule",
        className,
      )}
      {...props}
    />
  );
}

export type LineThreadSummaryProps = Omit<ComponentProps<"button">, "children"> & {
  /** The question that opened the thread. */
  quote: ReactNode;
  /** What the machine knows about it: "answered · 2 replies". */
  meta?: string;
};

/** A settled thread, collapsed to one line. It keeps its place in the diff. */
export function LineThreadSummary({
  quote,
  meta,
  className,
  ...props
}: LineThreadSummaryProps) {
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full cursor-pointer items-center gap-s4 border-l-2 border-rule pl-s6 text-left outline-none focus-visible:outline-solid focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <span className="type-detail text-muted-foreground group-hover:text-ink">{quote}</span>
      {meta != null && (
        <span className="type-mono-xs shrink-0 text-faint">{meta}</span>
      )}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="shrink-0 stroke-faint"
      >
        <path
          d="M2.5 4.5 L6 8 L9.5 4.5"
          fill="none"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export type ChatTurnProps = Omit<ComponentProps<"div">, "children"> & {
  /** Who is speaking. A name, not an avatar. */
  author: string;
  /** Beside the name: what the turn is anchored to, in place of a timestamp. */
  anchor?: string;
  /** Beside the name while streaming: what the agent is reading right now. */
  activity?: string;
  /** A question is set heavier than an answer; intent is what gets scanned for. */
  kind?: "question" | "answer";
  /** Shows the caret at the end of the text. The caret is the only motion. */
  streaming?: boolean;
  /** `Citations`, under the text. */
  citations?: ReactNode;
  children: ReactNode;
};

/**
 * One turn of an exchange. No bubbles: a mono name, then prose. The mono
 * line (`author`, `anchor`, `activity`) takes strings the system supplies:
 * an identity, a line reference, a file being read. Never copy.
 */
export function ChatTurn({
  author,
  anchor,
  activity,
  kind = "answer",
  streaming = false,
  citations,
  className,
  children,
  ...props
}: ChatTurnProps) {
  return (
    <div className={cn("flex flex-col gap-[6px]", className)} {...props}>
      <div className="type-mono-xs flex items-center gap-s2 text-faint">
        <span>
          {author}
          {anchor != null && <> · {anchor}</>}
        </span>
        {activity != null && <span className="text-flare-deep">{activity}</span>}
      </div>
      <div
        className={
          kind === "question"
            ? "font-display text-body-m leading-body-s font-medium tracking-heading text-ink"
            : "type-body text-ink"
        }
      >
        {children}
        {streaming && (
          <span
            aria-hidden="true"
            className="animate-[caret-blink_1s_steps(1)_infinite] motion-reduce:animate-none"
          >
            ▍
          </span>
        )}
      </div>
      {citations != null && <div className="mt-s1">{citations}</div>}
    </div>
  );
}

export type SettledExchangeProps = Omit<ComponentProps<"div">, "children"> & {
  question: ReactNode;
  /** Who asked and when: "priya · 1h ago". */
  byline?: string;
  /** The answer. */
  children: ReactNode;
};

/** An exchange someone else already had: the answer drops to muted. */
export function SettledExchange({
  question,
  byline,
  className,
  children,
  ...props
}: SettledExchangeProps) {
  return (
    <div className={cn("flex flex-col gap-s1", className)} {...props}>
      <div className="flex items-baseline justify-between gap-s7">
        <div className="font-display text-body leading-body-s font-medium tracking-heading text-ink">
          {question}
        </div>
        {byline != null && (
          <div className="type-mono-xs shrink-0 text-faint">{byline}</div>
        )}
      </div>
      <div className="type-body-s text-muted-foreground">{children}</div>
    </div>
  );
}

/** A row of `Citation`s. Citations are lines, not files. */
export function Citations({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  const items = Children.toArray(children);
  return (
    <div className={cn("flex flex-wrap items-center gap-s4", className)} {...props}>
      {items.map((item, index) => (
        <span key={index} className="contents">
          {index > 0 && (
            <span aria-hidden="true" className="font-mono text-mono-xs leading-mono-xs text-faint">
              ·
            </span>
          )}
          {item}
        </span>
      ))}
    </div>
  );
}

export function Citation({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "type-mono-xs cursor-pointer text-muted-foreground underline decoration-1 underline-offset-[3px] outline-none hover:text-ink focus-visible:outline-solid focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

export type AskFieldProps = Omit<
  ComponentProps<"input">,
  "size" | "onSubmit" | "className"
> & {
  /** `page` sits under the intent, scoped to the whole change; `inline` lives in a line thread. */
  size?: "page" | "inline";
  /** What the question is anchored to: "line 46". Stated, not implied. */
  scope?: string;
  /**
   * Set while the agent answers. The field goes quiet, the send becomes a
   * stop, and this replaces the placeholder: "answering · 2.1s".
   */
  answering?: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onStop?: () => void;
  className?: string;
};

/**
 * Where a question enters. A pill, not a chat box: what it is scoped to on
 * the left, one send affordance on the right, and it never grows a toolbar.
 */
export function AskField({
  size = "inline",
  scope,
  answering,
  onSubmit,
  onStop,
  className,
  ...inputProps
}: AskFieldProps) {
  const page = size === "page";
  const busy = answering != null;
  const buttonSize = page ? "icon-sm" : "icon-xs";
  const arrow = page ? 14 : 12;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
      className={cn("w-full", className)}
    >
      <InputGroup
        className={cn(
          "rounded-pill border border-border focus-within:border-ink has-[[data-slot=input-group-control]:focus-visible]:border-ink",
          page ? "gap-s5 py-s4 pr-s4 pl-s7" : "gap-s5 py-s2 pr-s2 pl-[18px]",
          busy ? "bg-surface" : "bg-ground",
        )}
      >
        {scope != null && !busy && (
          <span className="-mr-[2px] flex shrink-0 items-center gap-[14px]">
            <span className="type-mono-xs text-flare-deep">{scope}</span>
            <span aria-hidden="true" className="h-s5 w-px bg-border" />
          </span>
        )}
        {busy ? (
          <span role="status" className="type-mono-xs grow text-muted-foreground">
            {answering}
          </span>
        ) : (
          <InputGroupInput
            type="text"
            className={cn(
              "min-w-0 grow bg-transparent font-display text-ink outline-none placeholder:text-faint",
              page ? "text-body leading-body-s" : "text-ui leading-ui",
            )}
            {...inputProps}
          />
        )}
        {busy ? (
          <InputGroupButton
            type="button"
            aria-label="Stop"
            onClick={onStop}
            variant="default"
            size={buttonSize}
          >
            <span aria-hidden="true" className="size-[9px] rounded-[2px] bg-on-ink" />
          </InputGroupButton>
        ) : (
          <InputGroupButton type="submit" aria-label="Send" variant="default" size={buttonSize}>
            <svg
              width={arrow}
              height={arrow}
              viewBox={`0 0 ${arrow} ${arrow}`}
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path
                d={
                  page
                    ? "M7 11.5 L7 3 M3.4 6.4 L7 2.8 L10.6 6.4"
                    : "M6 10 L6 2.5 M2.8 5.7 L6 2.4 L9.2 5.7"
                }
              />
            </svg>
          </InputGroupButton>
        )}
      </InputGroup>
    </form>
  );
}
