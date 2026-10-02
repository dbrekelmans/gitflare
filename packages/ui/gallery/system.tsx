import type { ReactNode } from "react";
import { FlareField } from "#components/flare-field";
import {
  Claim,
  FloatingCard,
  FloatingCardActions,
  FloatingCardBody,
  FloatingCardClaims,
  FloatingCardHead,
} from "#components/floating-card";
import { Logo } from "#components/logo";
import { Row } from "#components/row";
import { Chip, StatusBadge, StatusPill } from "#components/status";
import { Evidence, Heading, Text, TextLink } from "#components/typography";
import { Button } from "#components/ui/button";
import { cn } from "#lib/utils";
import { Note, Statement } from "./kit";
import { hex, namespace, token } from "./tokens";

function Swatch({
  name,
  label,
  value,
  hexValue,
  className,
}: {
  name: string;
  label: string;
  value: string;
  /** For tokens that live in globals.css rather than theme.css. */
  hexValue?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-[180px] flex-1 basis-0 flex-col justify-end gap-[6px] p-[18px]",
        className,
      )}
      style={{ backgroundColor: `var(${name})` }}
    >
      <div className={cn("type-mono-xs", label)}>{name}</div>
      <div className={cn("font-mono text-detail leading-xs", value)}>
        {hexValue ?? hex(token(name).value)}
      </div>
    </div>
  );
}

function RoleRow({
  name,
  bordered = false,
  mapped,
}: {
  name: string;
  bordered?: boolean;
  /** For tokens that live in globals.css rather than theme.css. */
  mapped?: { value: string; note: string };
}) {
  const { value, note } = mapped ?? token(name);
  return (
    <div className="flex items-center gap-[32px] border-t border-rule py-s5">
      <div
        className={cn(
          "size-[28px] shrink-0 rounded-[8px]",
          bordered && "border border-border-press",
        )}
        style={{ backgroundColor: `var(${name})` }}
      />
      <Evidence kind="id" className="w-[260px] shrink-0">
        {name}
      </Evidence>
      <Evidence className="w-[104px] shrink-0">{hex(value)}</Evidence>
      <Text tone="muted" className="flex-1">
        {note}
      </Text>
    </div>
  );
}

function Colour() {
  return (
    <section className="px-s13 pt-[76px]">
      <Statement title="Warm-neutral, and one orange." pad="pb-[36px]">
        Every neutral carries a yellow-red bias; none is grey. Flare is the
        only accent, and it is load-bearing.
      </Statement>

      <div className="flex">
        <Swatch name="--color-flare" label="text-flare-shade" value="text-on-flare" className="rounded-l-panel" />
        <Swatch name="--color-flare-deep" label="text-flare-shade" value="text-on-flare" />
        <Swatch name="--color-ink" label="text-faint-inverse" value="text-on-ink" />
        <Swatch name="--color-muted-foreground" hexValue="#6F6B66" label="text-rule" value="text-on-ink" />
        <Swatch name="--color-flare-tint" label="text-flare-deep" value="text-flare-deep" />
        <Swatch name="--color-surface" label="text-faint" value="text-ink" />
        <Swatch name="--color-ground" label="text-faint" value="text-ink" className="rounded-r-panel border border-border" />
      </div>

      <div className="pt-s10">
        <RoleRow name="--color-flare-shade" />
        <RoleRow name="--color-faint" />
        <RoleRow name="--color-faint-inverse" />
        <RoleRow
          name="--color-border"
          bordered
          mapped={{ value: "#EAE7E3", note: "card outlines and dividers inside a card" }}
        />
        <RoleRow name="--color-rule" bordered />
        <div className="border-t border-rule" />
      </div>

      <FlareField className="mt-s12 flex items-end gap-[80px] px-s11 py-s10">
        <div className="flex w-[600px] shrink-0 flex-col gap-[18px]">
          <Heading level={3} className="text-[34px] leading-[40px] font-bold tracking-display">
            Neutrals are replaced by white at alpha.
          </Heading>
          <Text size="body-m" tone="muted">
            Body copy runs at 94%. Nothing on this field is set in ink.
          </Text>
        </div>
        <div className="flex grow flex-col gap-[14px]">
          {(["--color-on-flare-fill", "--color-on-flare-border", "--color-on-flare-body"] as const).map(
            (name) => (
              <div key={name} className="flex items-center gap-[14px]">
                <div
                  className="size-[52px] shrink-0 rounded-chip"
                  style={{ backgroundColor: `var(${name})` }}
                />
                <Evidence>
                  {hex(token(name).value)} · {token(name).note}
                </Evidence>
              </div>
            ),
          )}
        </div>
      </FlareField>

      <div className="pt-s12">
        <div className="flex items-end gap-s13 pb-s9">
          <Heading level={3} size="display-s" className="w-claim shrink-0 font-medium">
            Status is not a second accent.
          </Heading>
          <Text tone="muted" className="w-support shrink-0">
            Three semantic colours, each pulled far enough from flare that
            neither reads as a variant of the other.
          </Text>
        </div>
        <div className="flex">
          <Swatch name="--color-success" label="text-success-tint" value="text-on-success" className="rounded-l-panel" />
          <Swatch name="--color-warning" label="text-warning-tint" value="text-on-warning" />
          <Swatch name="--color-danger" label="text-danger-tint" value="text-on-danger" className="rounded-r-panel" />
        </div>
        <div className="flex items-center gap-s7 pt-s10">
          <StatusBadge tone="success">verified</StatusBadge>
          <StatusBadge tone="warning">unverified</StatusBadge>
          <StatusBadge tone="danger">checks failed</StatusBadge>
          <StatusBadge tone="flare">flare, for reference</StatusBadge>
          <Text size="detail" tone="faint" className="grow text-right leading-ui">
            The dot at 8px is the hardest case.
          </Text>
        </div>
        <div className="pt-s10">
          {namespace("--color-")
            .filter(({ name }) => /-(success|warning|danger)-(deep|tint)$/.test(name))
            .map(({ name }) => (
              <RoleRow key={name} name={name} bordered={name.endsWith("-tint")} />
            ))}
          <div className="border-t border-rule" />
        </div>
      </div>
    </section>
  );
}

const scale: Array<{
  type: string;
  pad: string;
  spec: string;
  sample: string;
  tone?: string;
}> = [
  { type: "type-display-xl", pad: "pt-s8 pb-s9", spec: "display xl · 74/78 · 700 · −0.03em", sample: "Meter the usage" },
  { type: "type-display-l", pad: "pt-[26px] pb-s8", spec: "display l · 56/62 · 700 · −0.03em", sample: "Meter API usage, bill on it" },
  { type: "type-display-m", pad: "pt-s7 pb-[28px]", spec: "display m · 50/55 · 700 · −0.03em", sample: "Four units, each one green" },
  { type: "type-display-s", pad: "pt-[22px] pb-[26px]", spec: "display s · 44/50 · 700 · −0.03em", sample: "What was checked without you" },
  { type: "type-lede", pad: "pt-[22px] pb-s7", spec: "lede · 24/32 · 600 · −0.015em", sample: "Should metering share the rate-limit counters?" },
  { type: "type-statement", pad: "pt-s6 pb-[22px]", spec: "statement · 22/32 · 600 · −0.01em", sample: "This is a roadmap call, not a code call.", tone: "text-flare-deep" },
  { type: "type-title", pad: "pt-s6 pb-[22px]", spec: "title · 19/26 · 600 · −0.01em", sample: "What needs you" },
  { type: "type-body-l", pad: "py-s6", spec: "body l · 20/31 · 400", sample: "Charge teams for API calls above their plan allowance." },
  { type: "type-body-m", pad: "py-[18px]", spec: "body m · 17/28 · 400", sample: "Both count events per user. Sharing saves one abstraction now.", tone: "text-muted-foreground" },
  { type: "type-body", pad: "py-[18px]", spec: "body · 16/26 · 400", sample: "Splitting costs about two days later if billing needs audit-grade accuracy.", tone: "text-muted-foreground" },
  { type: "type-body-s", pad: "py-[18px]", spec: "body s · 15/24 · 400", sample: "Each unit compiles, tests, and reverts on its own.", tone: "text-muted-foreground" },
  { type: "type-ui", pad: "py-[18px]", spec: "ui · 15/18 · 500", sample: "Merge 3 of 4 units now" },
  { type: "type-meta", pad: "py-[18px]", spec: "meta · 14/18 · 500", sample: "split into 4 units, each green" },
];

function Typography() {
  return (
    <section className="px-s13 pt-s15">
      <Statement title="Two families. Mono means machine." pad="pb-[40px]">
        Schibsted Grotesk carries everything a person wrote. JetBrains Mono
        marks what a machine authored or verified, and nothing else.
      </Statement>

      <div>
        {scale.map(({ type, pad, spec, sample, tone }) => (
          <div key={type} className={cn("flex items-baseline gap-s11 border-t border-rule", pad)}>
            <div className={cn(type, "flex-1", tone ?? "text-ink")}>{sample}</div>
            <Evidence kind="note" size="sm" className="w-annotation shrink-0 text-right leading-body">
              {spec}
            </Evidence>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-s17 pt-s12">
        <div className="flex w-claim shrink-0 flex-col gap-[22px] rounded-panel bg-surface p-[32px]">
          <div className="flex flex-col gap-s2">
            <Evidence as="div" kind="id">
              intent #214 · confirmed by priya
            </Evidence>
            <Evidence as="div">
              meter usage per account so billing can bill it, without giving
              billing a second source of truth
            </Evidence>
          </div>
          <Chip className="self-start">provenance: agent/claude · human: approved-intent</Chip>
          <Evidence as="div" kind="note" size="sm" className="leading-body">
            processed in 11m 40s · $0.42
          </Evidence>
        </div>
        <div className="flex w-support shrink-0 flex-col gap-s5 pt-s2">
          <Heading level={3} size="statement">
            Monospace is a claim about authorship, not a texture.
          </Heading>
          <Text tone="muted">
            Three weights carry it: 500 for the identifying line, 400 for the
            payload, and 400 at low contrast for annotations that should stay
            unread until wanted.
          </Text>
        </div>
      </div>
    </section>
  );
}

function Ratio({
  title,
  spec,
  gap,
  children,
}: {
  title: string;
  spec: string;
  gap: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-s4">
      <div className="flex items-baseline gap-[14px]">
        <div className="font-display text-ui leading-body-s font-semibold text-ink">{title}</div>
        <Evidence kind="note" size="sm" className="leading-body-s">
          {spec}
        </Evidence>
      </div>
      <div className={cn("flex", gap)}>{children}</div>
    </div>
  );
}

function Column({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={cn("flex h-[44px] items-center rounded-[8px] px-s5 font-mono text-xs leading-xs", className)}>
      {children}
    </div>
  );
}

const claim = "shrink-0 bg-flare-tint text-flare-deep";
const evidence = "shrink-0 bg-border-disabled text-muted-foreground";

function Layout() {
  return (
    <section className="px-s13 pt-s15">
      <Statement title="Claim left, evidence right.">
        The left column carries the assertion; the right carries what backs
        it, narrower and quieter. The pair is never centred or equalised.
      </Statement>

      <div className="flex flex-col gap-s9">
        <Ratio title="Statement + support" spec="claim 680 / support 520 · gap 112" gap="gap-s17">
          <Column className={cn(claim, "w-claim")}>680</Column>
          <Column className={cn(evidence, "w-support")}>520</Column>
        </Ratio>
        <Ratio title="Section opener + support" spec="opener 800 / aside 400 · gap 88" gap="gap-s14">
          <Column className={cn(claim, "w-opener")}>800</Column>
          <Column className={cn(evidence, "w-aside")}>400</Column>
        </Ratio>
        <Ratio title="Row" spec="label 260 / body 660 / annotation 284 · gap 48" gap="gap-s11">
          <Column className={cn(claim, "w-label")}>260</Column>
          <Column className={cn(evidence, "w-body")}>660</Column>
          <Column className="w-annotation shrink-0 bg-surface text-faint">284</Column>
        </Ratio>
        <Ratio title="Pillars, three up" spec="flex-grow 1.45 / 1 / 1 · gap 64, uneven on purpose" gap="gap-s13">
          <Column className="grow-[1.45] basis-0 bg-flare-tint text-flare-deep">1.45</Column>
          <Column className="grow basis-0 bg-border-disabled text-muted-foreground">1</Column>
          <Column className="grow basis-0 bg-border-disabled text-muted-foreground">1</Column>
        </Ratio>
      </div>

      <div className="flex items-start gap-s17 pt-s12">
        <div className="flex w-claim shrink-0 flex-col gap-s5">
          <Heading level={3} size="statement">
            Space is loaded above a section, never below it.
          </Heading>
          <Text tone="muted">
            Top padding runs two to three times the bottom, so a heading stays
            attached to what it introduces. The page gutter is 64 and content
            is 1312 wide. Rows carry their own 1px top hairline; there is no
            divider element.
          </Text>
        </div>
        <div className="flex w-support shrink-0 flex-col gap-[14px] pt-[6px]">
          {[
            ["w-s18", "w-s12", "132 above · 56 below"],
            ["w-s16", "w-[40px]", "104 above · 40 below"],
            ["w-s15", "w-s7", "96 above · 24 below"],
            ["w-[76px]", "w-s2", "76 above · 8 below"],
          ].map(([above, below, label]) => (
            <div key={label} className="flex items-center gap-s5">
              <div className={cn("h-s5 shrink-0 rounded-[4px] bg-flare", above)} />
              <div className={cn("h-s5 shrink-0 rounded-[4px] bg-on-flare-press", below)} />
              <Evidence size="sm">{label}</Evidence>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Radius({ sample, use, children }: { sample: string; use: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-s4">
      <div className={cn("type-ui flex h-[52px] shrink-0 items-center", sample)}>{children}</div>
      <Evidence kind="note" size="sm" className="leading-body-s">
        {use}
      </Evidence>
    </div>
  );
}

function Form() {
  return (
    <section className="px-s13 pt-s15">
      <Statement title="Hairlines, not boxes.">
        Everything sits directly on the ground, separated by a single
        hairline. One shadow exists: in page flow it belongs to the floating
        card alone, and transient overlays borrow it while they are open.
      </Statement>

      <div className="flex items-end gap-[40px]">
        <Radius sample="rounded-pill bg-ink px-[28px] text-on-ink" use="buttons, badges">
          999 · pill
        </Radius>
        <Radius sample="rounded-card border-[1.5px] border-border px-s7 text-ink" use="floating card, dialog, flare field">
          24 · card
        </Radius>
        <Radius sample="rounded-panel bg-border-disabled px-s7 text-ink" use="popovers, insets">
          16 · panel
        </Radius>
        <Radius sample="rounded-chip bg-flare-tint px-s7 text-flare-deep" use="evidence chips, framed inputs">
          12 · chip
        </Radius>
        <Radius sample="rounded-control border-[1.5px] border-border px-s7 text-ink" use="checkbox">
          5 · control
        </Radius>
      </div>

      <div className="flex items-start gap-s17 pt-[52px]">
        <div className="flex w-claim shrink-0 flex-col gap-s6">
          {[
            ["border-t border-rule", "1px --color-rule · section hairline"],
            ["border-t border-border", "1px --color-border · divider inside a card"],
            ["border-t-[1.5px] border-border", "1.5px --color-border · card outline, secondary button"],
          ].map(([edge, label]) => (
            <div key={label} className="flex items-center gap-s6">
              <div className={cn("w-[220px] shrink-0", edge)} />
              <Evidence size="sm">{label}</Evidence>
            </div>
          ))}
          <Text tone="muted" className="pt-s2">
            The shadow is long, soft, and fully offset downward: no ambient
            second layer, no glow. It reads as height above the page.
          </Text>
        </div>
        <div className="flex w-support shrink-0 flex-col gap-[14px]">
          <div className="type-ui flex h-[120px] items-center justify-center rounded-card border-[1.5px] border-border bg-ground text-ink shadow-floating">
            The only elevated surface
          </div>
          <Evidence kind="note" size="sm">
            --shadow-floating · {token("--shadow-floating").value}
          </Evidence>
        </div>
      </div>
    </section>
  );
}

function Components() {
  return (
    <section className="px-s13 pt-s15">
      <Statement title="The parts, as they ship.">
        Gitflare's own components, rendered live. The generic controls after
        this section are shadcn/ui, edited to these tokens.
      </Statement>

      <div className="flex items-center gap-s12 pb-s10">
        <Logo />
        <div className="h-[40px] border-l border-rule" />
        <Button>Deploy your forge</Button>
        <Button variant="outline">Secondary</Button>
        <Button variant="ghost">Log in</Button>
        <div className="h-[40px] border-l border-rule" />
        <Logo wordmark={false} />
        <Logo size={16} />
      </div>

      <div className="flex items-start gap-s17 pb-s12">
        <FloatingCard className="w-card shrink-0">
          <FloatingCardHead>
            <Evidence kind="payload" className="leading-xs font-medium">
              change · add usage-based billing
            </Evidence>
            <StatusPill>1 question for you</StatusPill>
          </FloatingCardHead>
          <FloatingCardBody>
            <Heading level={3} size="lede">
              Should metering share the rate-limit counters, or will billing
              evolve separately?
            </Heading>
            <Text tone="muted">
              Both count events per user. Sharing saves one abstraction now;
              splitting costs ~2 days later if billing needs audit-grade
              accuracy. This is a roadmap call, not a code call.
            </Text>
            <FloatingCardActions>
              <Button>Evolves separately</Button>
              <Button variant="outline">Share counters</Button>
              <Text size="meta" tone="muted" className="pl-s2 text-pretty">
                Recommended: separate — billing precedent in 2 prior decisions
              </Text>
            </FloatingCardActions>
          </FloatingCardBody>
          <FloatingCardClaims
            state="verified"
            aside={<TextLink tone="quiet" href="#">view diff (you haven’t needed to in 12 days)</TextLink>}
          >
            <Claim>split into 4 units, each green</Claim>
            <Claim>auth path untouched</Claim>
            <Claim>7 findings resolved</Claim>
          </FloatingCardClaims>
        </FloatingCard>
        <div className="flex w-[320px] shrink-0 flex-col gap-[22px]">
          <Heading level={3} size="title">
            Three bands, one clipped container
          </Heading>
          <Text size="body-s" tone="muted">
            Head: 20/30, mono breadcrumb left, status pill right, 1px bottom
            border.
          </Text>
          <Text size="body-s" tone="muted">
            Body: 30/30/26, gap 16. Lede question, muted reasoning, then
            answers and an unboxed recommendation at 14px.
          </Text>
          <Text size="body-s" tone="muted">
            Claims strip: surface fill, 1px top border, 16/30, gap 20. Claims
            in ink, escape hatch right-aligned and muted.
          </Text>
        </div>
      </div>

      <div>
        <Row
          label="Standard row"
          annotation={
            <Evidence kind="note" size="sm" className="leading-body">
              22 / 26 · gap 48
            </Evidence>
          }
        >
          Label, description, annotation. No border, no fill: the hairline
          above is the only structure.
        </Row>
        <Row
          tone="inverse"
          label="Gitflare"
          annotation={
            <Evidence kind="note" size="sm" className="leading-body">
              tone=&quot;inverse&quot;
            </Evidence>
          }
        >
          Gitflare’s own row inverts to ink, gains 36 of horizontal padding
          and extra height, and takes no border and no radius; the fill alone
          marks it. Its label is the one place flare is used as a name.
        </Row>
      </div>
    </section>
  );
}

const rules: Array<[string, string]> = [
  ["One accent, load-bearing", "Flare appears on the flare field, the logo, status dots, tinted chips, and the one primary action a view is waiting on. Status colours are never a second accent."],
  ["Mono means machine", "Provenance, intents, verification, commit metadata. Never for emphasis, never for human-written copy, never as a label above a heading."],
  ["Claim left, evidence right", "The right column is always narrower and quieter. The pair is never centred."],
  ["No repeated equal cards", "Rows differ in height and treatment, the palette is one continuous bar. Three identical cards in a row is the shape this system exists to avoid."],
  ["Nothing decorative floats", "One shadow, on one surface per view. No glows, no gradients beyond the lift under the flare field."],
];

function Rules() {
  return (
    <section className="px-s13 pt-s15">
      <Statement title="What the system refuses.">
        The constraints that produce the look. The primitives make each of
        them the path of least resistance.
      </Statement>
      {rules.map(([title, body]) => (
        <div key={title} className="flex items-start gap-s11 border-t border-rule py-s7 last:border-b">
          <Heading level={3} size="title" className="w-[340px] shrink-0">
            {title}
          </Heading>
          <Text tone="muted" className="flex-1">
            {body}
          </Text>
        </div>
      ))}
    </section>
  );
}

export function System() {
  return (
    <>
      <header className="flex items-end gap-s17 px-s13 pt-s16 pb-s10">
        <Heading level={1} className="w-claim shrink-0 text-[62px] leading-[66px]">
          The system, as built.
        </Heading>
        <div className="flex w-support shrink-0 flex-col gap-[14px] pb-s2">
          <Text size="body-m" tone="muted">
            Every token and component in @gitflare/ui, in the order of the
            Paper style guide so the two can be read side by side. Values are
            Paper’s, not rounded to a scale.
          </Text>
          <Note>{`${namespace("--").length} tokens · read from src/styles/theme.css`}</Note>
        </div>
      </header>
      <Colour />
      <Typography />
      <Layout />
      <Form />
      <Components />
      <Rules />
    </>
  );
}
