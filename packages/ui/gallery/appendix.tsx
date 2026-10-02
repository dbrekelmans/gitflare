import type { ReactNode } from "react";
import { Evidence, Text } from "../src";
import { Statement } from "./kit";
import { hex, namespace } from "./tokens";
import type { Token } from "./tokens";

function Group({
  title,
  prefix,
  sample,
}: {
  title: string;
  prefix: string;
  sample: (token: Token) => ReactNode;
}) {
  const tokens = namespace(prefix);
  return (
    <div className="flex items-start gap-11 border-t border-rule pt-[22px] pb-9">
      <div className="w-label shrink-0">
        <Text className="text-body-m font-semibold">{title}</Text>
        <Evidence kind="note" size="sm">
          {prefix}* · {tokens.length}
        </Evidence>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-x-11 gap-y-[6px]">
        {tokens.map((token) => (
          <div key={token.name} className="flex min-h-[28px] items-center gap-5">
            <div className="flex w-[120px] shrink-0 items-center">{sample(token)}</div>
            <Evidence kind="id" className="w-[230px] shrink-0">
              {token.name}
            </Evidence>
            <Evidence className="truncate">
              {token.value.startsWith("#") ? hex(token.value) : token.value}
            </Evidence>
          </div>
        ))}
      </div>
    </div>
  );
}

const bar = (value: string) => (
  <div className="h-2 rounded-[2px] bg-flare" style={{ width: `min(${value}, 120px)` }} />
);

/** Every token in the theme, straight from the file. */
export function Appendix() {
  return (
    <section className="px-13 pt-15 pb-15">
      <Statement title="Every token.">
        Read from theme.css at build time: a token that is not in the theme
        cannot appear here, and one that is cannot be missing.
      </Statement>
      <Group
        title="Colour"
        prefix="--color-"
        sample={({ name }) => (
          <div className="rounded-[8px] bg-surface p-[3px]">
            <div
              className="h-[22px] w-[52px] rounded-[5px] border border-border-press"
              style={{ backgroundColor: `var(${name})` }}
            />
          </div>
        )}
      />
      <Group
        title="Family"
        prefix="--font-"
        sample={({ name }) => (
          <span className="text-ui leading-ui text-ink" style={{ fontFamily: `var(${name})` }}>
            Ag 0123
          </span>
        )}
      />
      <Group
        title="Size"
        prefix="--text-"
        sample={({ name }) => (
          <span className="leading-[28px] text-ink" style={{ fontSize: `min(var(${name}), 28px)` }}>
            Ag
          </span>
        )}
      />
      <Group
        title="Weight"
        prefix="--font-weight-"
        sample={({ name }) => (
          <span className="text-ui leading-ui text-ink" style={{ fontWeight: `var(${name})` }}>
            Flare
          </span>
        )}
      />
      <Group
        title="Tracking"
        prefix="--tracking-"
        sample={({ name }) => (
          <span className="text-ui leading-ui text-ink" style={{ letterSpacing: `var(${name})` }}>
            gitflare
          </span>
        )}
      />
      <Group
        title="Leading"
        prefix="--leading-"
        sample={({ name }) => (
          <div className="w-[3px] rounded-[2px] bg-flare" style={{ height: `min(var(${name}), 28px)` }} />
        )}
      />
      <Group title="Spacing" prefix="--spacing-" sample={({ value }) => bar(value)} />
      <Group
        title="Container"
        prefix="--container-"
        sample={({ value }) => (
          <div className="h-2 rounded-[2px] bg-flare" style={{ width: `calc(${value} / 12)` }} />
        )}
      />
      <Group
        title="Breakpoint"
        prefix="--breakpoint-"
        sample={({ value }) => (
          <div className="h-2 rounded-[2px] bg-rule" style={{ width: `calc(${value} / 12)` }} />
        )}
      />
      <Group
        title="Radius"
        prefix="--radius-"
        sample={({ name }) => (
          <div
            className="size-[28px] border-t-[1.5px] border-l-[1.5px] border-ink"
            style={{ borderTopLeftRadius: `min(var(${name}), 28px)` }}
          />
        )}
      />
      <Group
        title="Shadow"
        prefix="--shadow-"
        sample={({ name }) => (
          <div
            className="h-[22px] w-[52px] rounded-[5px] border border-border bg-ground"
            style={{ boxShadow: `var(${name})` }}
          />
        )}
      />
    </section>
  );
}
