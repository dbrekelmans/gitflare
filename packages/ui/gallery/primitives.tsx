import type { ReactNode } from "react";
import { useState } from "react";
import {
  AskField,
  Button,
  ChatTurn,
  Checkbox,
  Citation,
  Citations,
  Dialog,
  DialogBody,
  DialogFoot,
  DialogHead,
  ErrorText,
  Evidence,
  Heading,
  HelpText,
  Input,
  Label,
  LineThread,
  LineThreadSummary,
  Menu,
  MenuItem,
  MenuSeparator,
  Pill,
  Popover,
  Radio,
  SearchIcon,
  SectionHead,
  Segmented,
  Select,
  SettledExchange,
  SplitButton,
  StatusDot,
  StatusIcon,
  Switch,
  Table,
  Td,
  Text,
  Textarea,
  TextLink,
  Th,
  Tr,
} from "../src";
import type { StatusTone } from "../src";
import { Lane, Note, Sheet } from "./kit";

function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3">
      {children}
      <Note>{caption}</Note>
    </div>
  );
}

const statusTones: Array<[StatusTone, string]> = [
  ["success", "Approve"],
  ["warning", "Override"],
  ["danger", "Delete"],
];

function Buttons() {
  return (
    <Sheet
      title="Button"
      lede="Two primaries, split by what the action is. Flare marks a moment the system is waiting on; ink marks a standing action. Never more than one flare primary on screen."
    >
      <Lane label="Variants">
        <div className="flex items-start gap-5">
          <Captioned caption={'tone="flare" · a moment'}>
            <Button tone="flare">Drop replay</Button>
          </Captioned>
          <Captioned caption="primary · standing">
            <Button>Deploy your forge</Button>
          </Captioned>
          <Captioned caption={'variant="secondary"'}>
            <Button variant="secondary">Open the diff</Button>
          </Captioned>
          <Captioned caption={'variant="ghost"'}>
            <Button variant="ghost">Log in</Button>
          </Captioned>
          <Captioned caption="TextLink">
            <span className="flex h-[40px] items-center">
              <TextLink href="#">Read the transcript</TextLink>
            </span>
          </Captioned>
          <Captioned caption={'TextLink tone="quiet"'}>
            <span className="flex h-[40px] items-center">
              <TextLink href="#" tone="quiet">
                view diff
              </TextLink>
            </span>
          </Captioned>
        </div>
      </Lane>
      <Lane label="Sizes" center note="17 / 14+30 · 15 / 11+24 · 13 / 7+16">
        <div className="flex items-center gap-5">
          <Button tone="flare" size="lg">
            Large
          </Button>
          <Button tone="flare">Medium</Button>
          <Button tone="flare" size="sm">
            Small
          </Button>
        </div>
      </Lane>
      <Lane label="On ground" note="rest · disabled. Hover and pressed are live: point at one.">
        <div className="grid w-fit grid-cols-[repeat(4,auto)] items-center gap-5">
          <Button tone="flare">Merge</Button>
          <Button>Merge</Button>
          <Button variant="secondary">Merge</Button>
          <Button variant="ghost">Merge</Button>
          <Button tone="flare" disabled>
            Merge
          </Button>
          <Button disabled>Merge</Button>
          <Button variant="secondary" disabled>
            Merge
          </Button>
          <Button variant="ghost" disabled>
            Merge
          </Button>
        </div>
      </Lane>
      <Lane label="On flare" note="No flare primary here: white takes the moment, ink still stands.">
        <div className="on-flare grid w-fit grid-cols-[repeat(4,auto)] items-center gap-5 rounded-card bg-flare px-9 pt-8 pb-9">
          <Button tone="flare">Merge</Button>
          <Button>Merge</Button>
          <Button variant="secondary">Merge</Button>
          <Button variant="ghost">Merge</Button>
          <Button tone="flare" disabled>
            Merge
          </Button>
          <Button disabled>Merge</Button>
          <Button variant="secondary" disabled>
            Merge
          </Button>
          <Button variant="ghost" disabled>
            Merge
          </Button>
        </div>
      </Lane>
      <Lane label="Status tones" note="One per view, never two, and never on a flare field.">
        <div className="grid w-fit grid-cols-[repeat(3,auto)] items-center gap-x-5 gap-y-6">
          {statusTones.map(([tone, label]) => (
            <Button key={tone} tone={tone}>
              {label}
            </Button>
          ))}
          {statusTones.map(([tone, label]) => (
            <Button key={tone} variant="secondary" tone={tone}>
              {label}
            </Button>
          ))}
          {statusTones.map(([tone, label]) => (
            <Button key={tone} variant="ghost" tone={tone}>
              {label}
            </Button>
          ))}
        </div>
      </Lane>
    </Sheet>
  );
}

function ButtonGroups() {
  const [view, setView] = useState<"unified" | "split" | "unit">("unified");
  const options = [
    { value: "unified", label: "Unified diff" },
    { value: "split", label: "Split" },
    { value: "unit", label: "Per unit" },
  ] as const;
  return (
    <Sheet
      title="Button group"
      lede="Segments share one outline and one hairline between them. The selected segment is ink: a group is a view filter, not an action."
    >
      <Lane label="Segmented" center>
        <div className="flex items-center gap-5">
          <Segmented options={options} value={view} onChange={setView} />
          <Segmented options={options.slice(0, 2)} value="unified" disabled />
        </div>
      </Lane>
      <Lane label="Split" center note="State lands on one part; disabled takes the whole group.">
        <div className="flex items-center gap-5">
          <SplitButton>Merge all 4 units</SplitButton>
          <SplitButton variant="outline" trailing="128">
            Watch
          </SplitButton>
          <SplitButton disabled>Merge all</SplitButton>
          <SplitButton variant="outline" trailing="128" disabled>
            Watch
          </SplitButton>
        </div>
      </Lane>
    </Sheet>
  );
}

function Statuses() {
  return (
    <Sheet
      title="Status"
      lede="Flare means it is waiting on you. Everything checked without you stays quiet, in neutral, so the one thing that needs a person is the one thing with colour."
    >
      <Lane label="Pill" center note={"13px medium · 6+14 · dot 7\na status a person reads as a sentence"}>
        <div className="flex flex-wrap items-center gap-5">
          <Pill>1 question for you</Pill>
          <Pill mark={<StatusIcon kind="needs-you" />}>Ready — 1 question for you</Pill>
          <Pill tone="success">Landed</Pill>
          <Pill tone="warning">Stale</Pill>
          <Pill tone="danger">Checks failed</Pill>
          <Pill tone="neutral">Merged</Pill>
        </div>
      </Lane>
      <Lane label="Dot" center note="6px, beside a label in a table">
        <div className="flex items-center gap-7">
          <span className="flex items-center gap-2">
            <StatusDot />
            <Text as="span" size="meta" className="font-regular">
              1 question
            </Text>
          </span>
          <span className="flex items-center gap-2">
            <StatusDot tone="neutral" />
            <Text as="span" size="meta" tone="muted" className="font-regular">
              Verifying
            </Text>
          </span>
        </div>
      </Lane>
      <Lane label="Icon" center note={"14px\ndone · failed · needs-you · open"}>
        <div className="flex items-center gap-[26px]">
          {(
            [
              ["done", "intent confirmed"],
              ["failed", "video render failed — did not block"],
              ["needs-you", "routed to you as product"],
              ["open", "stated and left open"],
            ] as const
          ).map(([kind, label]) => (
            <span key={kind} className="flex items-center gap-2">
              <StatusIcon kind={kind} />
              <Text as="span" size="meta" tone={kind === "failed" ? "muted" : "ink"} className="font-regular">
                {label}
              </Text>
            </span>
          ))}
        </div>
      </Lane>
      <Lane label="Section head" note="28 / 20 · title 19 · aside 14 muted">
        <SectionHead title="What needs you" aside="1 open · 2 already answered" />
        <div className="flex items-center gap-[14px] border-b border-border py-[14px]">
          <StatusIcon kind="done" />
          <Text className="flex-1 leading-body-s">The auth path is untouched</Text>
          <Evidence className="w-[320px] shrink-0 text-right tracking-mono">
            0 of 312 changed files under src/auth
          </Evidence>
        </div>
      </Lane>
    </Sheet>
  );
}

function Forms() {
  const [depth, setDepth] = useState("");
  return (
    <Sheet
      title="Form"
      lede="A field is a rule you type on. Focus thickens that rule to 1.5px ink rather than adding a glow. Controls mark in ink; only the switch takes flare, because it reports something live."
    >
      <Lane label="Label" note={"13px medium ink\nthe machine-facing half in mono, right"}>
        <div className="flex w-support flex-col gap-[6px]">
          <Label htmlFor="g-repo" hint="required">
            Repository name
          </Label>
          <HelpText>Lowercase, hyphens only. This becomes the forge subdomain.</HelpText>
        </div>
      </Lane>
      <Lane label="Input" note={"rest · filled · focus is live\n16/24 · rule 1px, 1.5px ink on focus"}>
        <div className="flex w-aside flex-col gap-[32px]">
          <Input id="g-repo" placeholder="metering-service" />
          <Input defaultValue="billing-evolves-separately" aria-label="Decision" />
        </div>
      </Lane>
      <Lane label="Invalid" note="The only place flare enters a control, as a status dot.">
        <div className="flex w-aside flex-col gap-3">
          <Input defaultValue="Metering Service" aria-invalid aria-label="Subdomain" />
          <ErrorText>Uppercase and spaces aren’t allowed in a subdomain.</ErrorText>
        </div>
      </Lane>
      <Lane label="Framed" note={"radius 12 · 1.5px border\noverlays and table filters only"}>
        <div className="w-aside">
          <Input variant="framed" leading={<SearchIcon />} placeholder="Filter 1,284 commits" aria-label="Filter commits" />
        </div>
      </Lane>
      <Lane label="Multiline" note="grows to content; the rule stays at the last line">
        <div className="w-aside">
          <Textarea
            aria-label="Reasoning"
            defaultValue="Sharing saves one abstraction now; splitting costs about two days later if billing needs audit-grade accuracy."
          />
        </div>
      </Lane>
      <Lane label="Checkbox" note={"18px · radius 5\nchecked · empty · mixed · disabled"}>
        <div className="flex w-aside flex-col gap-6">
          <Checkbox defaultChecked>Split the change into units before review</Checkbox>
          <Checkbox>Run the full verification suite on every push</Checkbox>
          <Checkbox indeterminate>Notify on findings — 2 of 5 severities</Checkbox>
          <Checkbox disabled>Auto-merge (requires a paid plan)</Checkbox>
        </div>
      </Lane>
      <Lane label="Radio" note={"18px · full circle\ndescription optional, 13px muted"}>
        <div className="flex w-aside flex-col gap-6">
          <Radio name="g-billing" defaultChecked description="Costs about two days later, keeps audit-grade accuracy.">
            Billing evolves separately
          </Radio>
          <Radio name="g-billing" description="Saves one abstraction now.">
            Share the rate-limit counters
          </Radio>
        </div>
      </Lane>
      <Lane label="Switch" note={"44 × 26 · knob 20\non = flare, off = rule\nlabel left, switch right"}>
        <div className="flex w-aside flex-col gap-6">
          <Switch defaultChecked>Verify before it reaches me</Switch>
          <Switch>Email me every finding</Switch>
        </div>
      </Lane>
      <Lane label="Select" note={"value 16px · chevron 12 × 8\nempty takes the placeholder, faint"}>
        <div className="flex w-aside flex-col gap-[28px]">
          <Select defaultValue="unit" aria-label="Verification depth">
            <option value="unit">Verify every unit</option>
            <option value="merged">Verify the merged result only</option>
          </Select>
          <Select
            placeholder="Choose a verification depth"
            value={depth}
            onChange={(event) => setDepth(event.target.value)}
            aria-label="Verification depth"
          >
            <option value="unit">Verify every unit</option>
            <option value="merged">Verify the merged result only</option>
          </Select>
        </div>
      </Lane>
    </Sheet>
  );
}

function Overlays() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      title="Overlay"
      lede="One overlay surface: the same panel carries a menu's options or a popover's content, and the dialog is the floating card promoted. Whichever is open is the view's one elevated surface."
    >
      <Lane label="Menu" note={"panel 16 · pad 8 · item 10+16\nselected = surface fill + check"}>
        <Menu aria-label="Verification depth">
          <MenuItem selected>Verify every unit</MenuItem>
          <MenuItem>Verify the merged result only</MenuItem>
          <MenuItem>Verify on request</MenuItem>
          <MenuSeparator />
          <MenuItem quiet>Never verify</MenuItem>
        </Menu>
      </Lane>
      <Lane label="Popover" note={"pad 20 · gap 14 · max 400\nsmall buttons only · no tail"}>
        <Popover>
          <Evidence size="xs">a3f19c2 · 4 units</Evidence>
          <Heading level={4} size="title">
            Why this split
          </Heading>
          <Text size="sm" tone="muted">
            Each unit compiles, tests, and reverts on its own. The auth path
            was left untouched so it stays out of the review surface.
          </Text>
          <div className="flex items-center gap-3 pt-1">
            <Button tone="flare" size="sm">
              View diff
            </Button>
            <Button variant="secondary" size="sm">
              Dismiss
            </Button>
          </div>
        </Popover>
      </Lane>
      <Lane
        label="Dialog"
        note={"600 wide · radius 24\nhead 16+30 · body 30 · foot 20+30\nscrim: ink at 40%, no blur"}
      >
        <Dialog open modal={false} aria-label="Question">
          <DialogHead>
            <Evidence className="tracking-mono">change · drop legacy webhook path</Evidence>
            <Pill>1 question for you</Pill>
          </DialogHead>
          <DialogBody>
            <Heading level={4} size="lede">
              Unit 3 fails on replay. Drop replay support, or hold the change
              until it passes?
            </Heading>
            <Text tone="muted">
              Nothing else in the change depends on replay. Two customers
              called the endpoint last quarter, both from a deprecated SDK.
            </Text>
          </DialogBody>
          <DialogFoot>
            <Text as="span" size="meta" tone="muted" className="font-regular">
              Recommended: drop it
            </Text>
            <div className="flex items-center gap-3">
              <Button variant="secondary">Hold the change</Button>
              <Button tone="flare">Drop replay</Button>
            </div>
          </DialogFoot>
        </Dialog>
        <div className="pt-6">
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Open it as a modal
          </Button>
        </div>
        <Dialog open={open} onClose={() => setOpen(false)} aria-label="Question">
          <DialogHead>
            <Evidence className="tracking-mono">change · drop legacy webhook path</Evidence>
            <Pill>1 question for you</Pill>
          </DialogHead>
          <DialogBody>
            <Heading level={4} size="lede">
              Drop replay support, or hold the change until it passes?
            </Heading>
          </DialogBody>
          <DialogFoot>
            <Text as="span" size="meta" tone="muted" className="font-regular">
              Recommended: drop it
            </Text>
            <div className="flex items-center gap-3">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Hold the change
              </Button>
              <Button tone="flare" onClick={() => setOpen(false)}>
                Drop replay
              </Button>
            </div>
          </DialogFoot>
        </Dialog>
      </Lane>
    </Sheet>
  );
}

const changes = [
  { title: "Add usage-based billing", tone: "flare", status: "1 question", units: "4 / 4 green", claim: "auth path untouched · 7 findings resolved", opened: "2h ago", selected: true },
  { title: "Migrate sessions to Durable Objects", tone: "neutral", status: "Verifying", units: "2 / 6 green", claim: "preview running · 3 findings open", opened: "yesterday" },
  { title: "Rate-limit counters per tenant", tone: "neutral", status: "Merged", units: "3 / 3 green", claim: "no findings · claims held on preview", opened: "4 days ago" },
  { title: "Drop the legacy webhook path", tone: "neutral", status: "Blocked", units: "1 / 5 green", claim: "unit 3 fails on replay · needs your call", opened: "6 days ago" },
] as const;

function Tables() {
  return (
    <Sheet
      title="Table"
      lede="Horizontal hairlines only. No vertical rules, no zebra, no outer border. Machine columns are mono; human columns are not."
    >
      <Table>
        <thead>
          <tr>
            <Th className="w-[42px]">
              <Checkbox aria-label="Select all changes" />
            </Th>
            <Th className="w-[304px]">Change</Th>
            <Th className="w-[144px]">Status</Th>
            <Th className="w-[134px]">Units</Th>
            <Th>Verified claim</Th>
            <Th align="right" className="w-[110px]">
              Opened
            </Th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <Tr key={change.title} selected={"selected" in change}>
              <Td>
                <Checkbox defaultChecked={"selected" in change} aria-label={`Select ${change.title}`} />
              </Td>
              <Td kind="primary">{change.title}</Td>
              <Td tone={change.tone === "flare" ? "ink" : "muted"}>
                <span className="flex items-center gap-2">
                  <StatusDot tone={change.tone} />
                  {change.status}
                </span>
              </Td>
              <Td kind="machine">{change.units}</Td>
              <Td>{change.claim}</Td>
              <Td kind="machine" align="right" tone="faint">
                {change.opened}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Sheet>
  );
}

function Chat() {
  return (
    <Sheet
      title="Chat"
      lede="An exchange with the agent that wrote the code. No bubbles, no avatars: a mono name, then prose. The question is set heavier than the answer."
    >
      <Lane label="Question" note={"17px medium ink\nthe anchor replaces a timestamp"}>
        <ChatTurn kind="question" author="you" anchor="on line 46" className="w-body">
          Why is the counter bump its own call now?
        </ChatTurn>
      </Lane>
      <Lane label="Answer" note={"16/26 ink\nprose stays in the display face"}>
        <ChatTurn author="claude-code" className="w-body">
          Because the ledger insert is idempotent and an increment isn’t.
          bumpCounter now recomputes the day’s total from the ledger instead
          of adding to it, so replaying is free.
        </ChatTurn>
      </Lane>
      <Lane label="Streaming" note={"what it is reading sits beside the name\nthe caret is the only motion"}>
        <ChatTurn author="claude-code" activity="reading scripts/backfill.ts" streaming className="w-body">
          Yes. The backfill replays historical events through recordEvent
          rather than writing counters directly, so it runs in batches of 500
          per tenant and
        </ChatTurn>
      </Lane>
      <Lane label="Cited" note={"citations are lines, not files\nthey scroll the diff"}>
        <ChatTurn
          author="claude-code"
          className="w-body"
          citations={
            <Citations>
              <Citation href="#">ledger.ts:52</Citation>
              <Citation href="#">0007_usage_ledger.sql:4</Citation>
              <Citation href="#">step 3</Citation>
            </Citations>
          }
        >
          Nothing else writes to the counter table, so the invariant holds for
          every path that reaches it.
        </ChatTurn>
      </Lane>
      <Lane label="Settled" note={"an exchange someone else already had\nthe answer drops to muted"}>
        <SettledExchange
          question="Does the overage rate apply retroactively?"
          byline="priya · 1h ago"
          className="w-body"
        >
          No — it takes effect at the next billing cycle boundary, not
          retroactively.
        </SettledExchange>
      </Lane>
    </Sheet>
  );
}

function AskFields() {
  return (
    <Sheet
      title="Ask field"
      lede="Where a question enters. A pill, not a chat box: what it is scoped to on the left, one send affordance on the right, and it never grows a toolbar."
    >
      <Lane label="Page" note={"16px · 34px control\nscoped to the whole change"}>
        <div className="w-body">
          <AskField size="page" placeholder="Ask about this change…" aria-label="Ask about this change" />
        </div>
      </Lane>
      <Lane label="Inline" note={"15px · 28px control\nthe one inside a line thread"}>
        <div className="w-support">
          <AskField placeholder="Ask a follow-up…" aria-label="Ask a follow-up" />
        </div>
      </Lane>
      <Lane label="Scoped" note={"the anchor is stated, not implied\nflare here is a scope mark"}>
        <div className="w-support">
          <AskField
            scope="line 46"
            defaultValue="Does the backfill go through this path too?"
            aria-label="Ask about line 46"
          />
        </div>
      </Lane>
      <Lane label="Answering" note={"the field goes quiet and the send becomes a stop"}>
        <div className="w-support">
          <AskField answering="answering · 2.1s" />
        </div>
      </Lane>
    </Sheet>
  );
}

function DiffLine({ number, added = false, marked = false, children }: { number: number; added?: boolean; marked?: boolean; children: string }) {
  return (
    <div className={`flex items-center py-px pr-2 ${added ? "bg-success-tint" : "bg-surface"}`}>
      <div className="flex w-[22px] shrink-0 items-center pl-[6px]">
        {marked && <div className="h-5 w-[3px] rounded-pill bg-flare" />}
      </div>
      <span className="type-mono-sm w-[40px] shrink-0 text-right text-faint">{number}</span>
      <span className="type-mono w-[22px] shrink-0 text-center text-success">{added ? "+" : ""}</span>
      <span className={`type-mono grow whitespace-pre ${added ? "text-ink" : "text-muted"}`}>
        {children}
      </span>
    </div>
  );
}

function LineThreads() {
  return (
    <Sheet
      title="Line thread"
      lede="A conversation pinned to a line of the diff. It opens in place, indented to the code it belongs to, held by a single rule: flare while it is live, grey once it has settled."
    >
      <Lane label="Open" note={"indent 62 · rule 2px flare\ngap 18 between turns\nno card, no shadow: the rule\nis the whole container"}>
        <div className="w-body">
          <DiffLine number={45}>{"  const day = utcDay(e.at);"}</DiffLine>
          <DiffLine number={46} added marked>
            {"  await bumpCounter(db, e.tenantId, day);"}
          </DiffLine>
          <LineThread className="mt-5 ml-[62px]">
            <ChatTurn kind="question" author="you" anchor="on line 46">
              Why is the counter bump its own call now?
            </ChatTurn>
            <ChatTurn author="claude-code">
              Because the ledger insert is idempotent and an increment isn’t.
              Sharing one statement meant a retry counted the same event twice.
            </ChatTurn>
            <AskField placeholder="Ask a follow-up…" aria-label="Ask a follow-up" className="max-w-[480px]" />
            <Evidence kind="note" size="xs">
              the answer is written against this diff, not the whole repo
            </Evidence>
          </LineThread>
        </div>
      </Lane>
      <Lane label="Collapsed" note={"a settled thread keeps its place in the diff\nbut drops to one line and a grey rule"}>
        <div className="w-body">
          <div className="ml-[62px]">
            <LineThreadSummary
              quote="“Does this need an index on tenant_id alone?”"
              meta="answered · 2 replies"
            />
          </div>
        </div>
      </Lane>
    </Sheet>
  );
}

export function Primitives() {
  return (
    <>
      <Buttons />
      <ButtonGroups />
      <Statuses />
      <Forms />
      <Overlays />
      <Tables />
      <Chat />
      <AskFields />
      <LineThreads />
    </>
  );
}
