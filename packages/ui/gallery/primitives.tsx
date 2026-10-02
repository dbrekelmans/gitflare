import type { ReactNode } from "react";
import { useState } from "react";
import {
  AskField,
  ChatTurn,
  Citation,
  Citations,
  LineThread,
  LineThreadSummary,
  SettledExchange,
} from "#components/chat";
import {
  Claim,
  FloatingCard,
  FloatingCardActions,
  FloatingCardBody,
  FloatingCardClaims,
  FloatingCardHead,
} from "#components/floating-card";
import { ChevronDown } from "#components/icons";
import { SectionHead } from "#components/row";
import { StatusDot, StatusIcon, StatusPill } from "#components/status";
import { Evidence, Heading, Text, TextLink } from "#components/typography";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from "#components/ui/button-group";
import { Checkbox } from "#components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "#components/ui/field";
import { Input } from "#components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "#components/ui/popover";
import { RadioGroup, RadioGroupItem } from "#components/ui/radio-group";
import { ScrollArea } from "#components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import { Separator } from "#components/ui/separator";
import { Skeleton } from "#components/ui/skeleton";
import { Switch } from "#components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#components/ui/tabs";
import { Textarea } from "#components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "#components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#components/ui/tooltip";
import { Lane, Note, Sheet } from "./kit";

function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-s3">
      {children}
      <Note>{caption}</Note>
    </div>
  );
}

const tones = [
  ["success", "Approve"],
  ["warning", "Override"],
  ["danger", "Delete"],
] as const;

function Buttons() {
  return (
    <Sheet
      title="Button"
      lede="Two primaries, split by what the action is. Ink is a standing action; flare marks the moment the system is waiting on. Never more than one flare button on screen."
    >
      <Lane label="Variants">
        <div className="flex items-start gap-s5">
          <Captioned caption="default · standing">
            <Button>Deploy your forge</Button>
          </Captioned>
          <Captioned caption={'variant="flare" · a moment'}>
            <Button variant="flare">Drop replay</Button>
          </Captioned>
          <Captioned caption={'variant="outline"'}>
            <Button variant="outline">Open the diff</Button>
          </Captioned>
          <Captioned caption={'variant="ghost"'}>
            <Button variant="ghost">Log in</Button>
          </Captioned>
          <Captioned caption={'variant="link"'}>
            <span className="flex h-10 items-center">
              <Button variant="link">Read the transcript</Button>
            </span>
          </Captioned>
        </div>
      </Lane>
      <Lane label="Sizes" center note="lg 17 / 14+30 · default 15 / 11+24 · sm 13 / 7+16">
        <div className="flex items-center gap-s5">
          <Button variant="flare" size="lg">
            Large
          </Button>
          <Button variant="flare">Default</Button>
          <Button variant="flare" size="sm">
            Small
          </Button>
          <Button variant="outline" size="icon" aria-label="More">
            <ChevronDown />
          </Button>
        </div>
      </Lane>
      <Lane label="On ground" note="rest above, disabled below. Hover, pressed and focus are live.">
        <div className="grid w-fit grid-cols-[repeat(4,auto)] items-center gap-s5">
          <Button variant="flare">Merge</Button>
          <Button>Merge</Button>
          <Button variant="outline">Merge</Button>
          <Button variant="ghost">Merge</Button>
          <Button variant="flare" disabled>
            Merge
          </Button>
          <Button disabled>Merge</Button>
          <Button variant="outline" disabled>
            Merge
          </Button>
          <Button variant="ghost" disabled>
            Merge
          </Button>
        </div>
      </Lane>
      <Lane label="On flare" note="No flare button here: white takes the moment, ink still stands.">
        <div className="on-flare grid w-fit grid-cols-[repeat(4,auto)] items-center gap-s5 rounded-card bg-flare px-s9 pt-s8 pb-s9">
          <Button variant="flare">Merge</Button>
          <Button>Merge</Button>
          <Button variant="outline">Merge</Button>
          <Button variant="ghost">Merge</Button>
          <Button variant="flare" disabled>
            Merge
          </Button>
          <Button disabled>Merge</Button>
          <Button variant="outline" disabled>
            Merge
          </Button>
          <Button variant="ghost" disabled>
            Merge
          </Button>
        </div>
      </Lane>
      <Lane label="Status tones" note="At most one status-toned button per view, and never on a flare field.">
        <div className="grid w-fit grid-cols-[repeat(3,auto)] items-center gap-x-s5 gap-y-s6">
          {tones.map(([tone, label]) => (
            <Button key={tone} tone={tone}>
              {label}
            </Button>
          ))}
          {tones.map(([tone, label]) => (
            <Button key={tone} variant="outline" tone={tone}>
              {label}
            </Button>
          ))}
          {tones.map(([tone, label]) => (
            <Button key={tone} variant="ghost" tone={tone}>
              {label}
            </Button>
          ))}
        </div>
      </Lane>
      <Lane label="Groups" center note="Segments share one outline; selected is ink, because a group filters a view.">
        <div className="flex flex-wrap items-center gap-s5">
          <ToggleGroup defaultValue={["unified"]} aria-label="Diff layout">
            <ToggleGroupItem value="unified">Unified diff</ToggleGroupItem>
            <ToggleGroupItem value="split">Split</ToggleGroupItem>
            <ToggleGroupItem value="unit">Per unit</ToggleGroupItem>
          </ToggleGroup>
          <ButtonGroup>
            <Button variant="flare">Merge all 4 units</Button>
            <ButtonGroupSeparator />
            <Button variant="flare" className="px-[14px]" aria-label="More merge options">
              <ChevronDown />
            </Button>
          </ButtonGroup>
          <ButtonGroup>
            <Button variant="outline" className="px-s5">
              Watch
            </Button>
            <ButtonGroupText>
              <Evidence className="leading-ui tracking-mono">128</Evidence>
            </ButtonGroupText>
          </ButtonGroup>
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
      <Lane label="Badge" center note={"13px medium · 6+14\ntinted, never solid"}>
        <div className="flex flex-wrap items-center gap-s5">
          <Badge>Needs you</Badge>
          <Badge variant="secondary">Merged</Badge>
          <Badge variant="success">Landed</Badge>
          <Badge variant="warning">Stale</Badge>
          <Badge variant="destructive">Checks failed</Badge>
          <Badge variant="outline">Draft</Badge>
        </div>
      </Lane>
      <Lane label="Status pill" center note={"a badge with its dot · dot 7\na status a person reads as a sentence"}>
        <div className="flex flex-wrap items-center gap-s5">
          <StatusPill>1 question for you</StatusPill>
          <StatusPill mark={<StatusIcon kind="needs-you" />}>Ready — 1 question for you</StatusPill>
          <StatusPill tone="success">Landed</StatusPill>
          <StatusPill tone="warning">Stale</StatusPill>
          <StatusPill tone="danger">Checks failed</StatusPill>
          <StatusPill tone="neutral">Merged</StatusPill>
        </div>
      </Lane>
      <Lane label="Dot" center note="6px, beside a label in a table">
        <div className="flex items-center gap-s7">
          <span className="flex items-center gap-s2">
            <StatusDot />
            <Text as="span" size="meta" className="font-regular">
              1 question
            </Text>
          </span>
          <span className="flex items-center gap-s2">
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
            <span key={kind} className="flex items-center gap-s2">
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
      <Lane label="Inline link" note="TextLink takes the size of the text around it">
        <Text tone="muted" className="max-w-body">
          Seven findings were resolved before this page existed. One larger
          refactor was out of scope and{" "}
          <TextLink href="#">filed as a proposal</TextLink>; the rest is in the
          shipping branch.
        </Text>
      </Lane>
    </Sheet>
  );
}

function Cards() {
  const card = (
    <FloatingCard>
      <FloatingCardHead>
        <Evidence className="leading-xs font-medium">change · add usage-based billing</Evidence>
        <StatusPill>1 question for you</StatusPill>
      </FloatingCardHead>
      <FloatingCardBody>
        <Heading level={4} size="lede">
          Should metering share the rate-limit counters, or will billing evolve
          separately?
        </Heading>
        <Text tone="muted">
          Both count events per user. Sharing saves one abstraction now;
          splitting costs ~2 days later if billing needs audit-grade accuracy.
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
        aside={
          <TextLink tone="quiet" href="#">
            view diff (you haven’t needed to in 12 days)
          </TextLink>
        }
      >
        <Claim>split into 4 units, each green</Claim>
        <Claim>auth path untouched</Claim>
        <Claim>7 findings resolved</Claim>
      </FloatingCardClaims>
    </FloatingCard>
  );
  return (
    <Sheet
      title="Floating card"
      lede="The one elevated surface in page flow. The lede balances when it wraps, the recommendation and the escape hatch wrap in place, and the claims keep to their row."
    >
      <div className="flex items-start gap-s11 pb-s10">
        <div className="w-card shrink-0">{card}</div>
        <Note>{"880 · max-w-card\nradius 24 · border 1.5\nshadow: ink at 25%, 0 24 48 −24"}</Note>
      </div>
      <div className="flex items-start gap-s11 pb-s10">
        <div className="w-[640px] shrink-0">{card}</div>
        <Note>{"640\nin a narrower column the same card holds its three bands: the claims wrap, the status never does"}</Note>
      </div>
    </Sheet>
  );
}

// Base UI's Select shows the raw value unless it is given the labels.
const depths = [
  { value: "unit", label: "Verify every unit" },
  { value: "merged", label: "Verify the merged result only" },
  { value: "request", label: "Verify on request" },
  { value: "never", label: "Never verify" },
];

function Forms() {
  const [depth, setDepth] = useState<string | null>(null);
  return (
    <Sheet
      title="Form"
      lede="A field is a rule you type on. Focus thickens that rule to 1.5px ink rather than adding a glow. Controls mark in ink; only the switch takes flare, because it reports something live."
    >
      <Lane label="Field" note={"label 13 medium · description 13 muted\nFieldError is a flare dot, not a red box"}>
        <FieldGroup className="w-aside">
          <Field>
            <FieldLabel htmlFor="g-repo">Repository name</FieldLabel>
            <Input id="g-repo" placeholder="metering-service" />
            <FieldDescription>Lowercase, hyphens only. This becomes the forge subdomain.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="g-decision">Decision</FieldLabel>
            <Input id="g-decision" defaultValue="billing-evolves-separately" />
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="g-sub">Subdomain</FieldLabel>
            <Input id="g-sub" defaultValue="Metering Service" aria-invalid />
            <FieldError>Uppercase and spaces aren’t allowed in a subdomain.</FieldError>
          </Field>
        </FieldGroup>
      </Lane>
      <Lane label="Framed" note={"InputGroup · radius 12 · 1.5px border\noverlays and table filters only"}>
        <div className="flex w-aside flex-col gap-s5">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Filter 1,284 commits" aria-label="Filter commits" />
          </InputGroup>
          <Input variant="framed" placeholder="Branch name" aria-label="Branch name" />
        </div>
      </Lane>
      <Lane label="Textarea" note="grows to content; the rule stays at the last line">
        <div className="w-aside">
          <Textarea
            aria-label="Reasoning"
            defaultValue="Sharing saves one abstraction now; splitting costs about two days later if billing needs audit-grade accuracy."
          />
        </div>
      </Lane>
      <Lane label="Checkbox" note={"18px · radius 5\nchecked · empty · mixed · disabled"}>
        <FieldGroup data-slot="checkbox-group" className="w-aside">
          <Field orientation="horizontal">
            <Checkbox id="g-c1" defaultChecked />
            <FieldLabel htmlFor="g-c1">Split the change into units before review</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="g-c2" />
            <FieldLabel htmlFor="g-c2">Run the full verification suite on every push</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="g-c3" indeterminate />
            <FieldLabel htmlFor="g-c3">Notify on findings — 2 of 5 severities</FieldLabel>
          </Field>
          <Field orientation="horizontal" data-disabled>
            <Checkbox id="g-c4" disabled />
            <FieldLabel htmlFor="g-c4">Auto-merge (requires a paid plan)</FieldLabel>
          </Field>
        </FieldGroup>
      </Lane>
      <Lane label="Radio" note={"18px · full circle\ndescription optional, 13px muted"}>
        <RadioGroup defaultValue="separate" className="w-aside" aria-label="Billing counters">
          <Field orientation="horizontal">
            <RadioGroupItem value="separate" id="g-r1" />
            <FieldContent>
              <FieldLabel htmlFor="g-r1">Billing evolves separately</FieldLabel>
              <FieldDescription>Costs about two days later, keeps audit-grade accuracy.</FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="share" id="g-r2" />
            <FieldContent>
              <FieldLabel htmlFor="g-r2">Share the rate-limit counters</FieldLabel>
              <FieldDescription>Saves one abstraction now.</FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
      </Lane>
      <Lane label="Switch" note={"44 × 26 · knob 20\non = flare, off = rule\nlabel left, switch right"}>
        <FieldGroup data-slot="checkbox-group" className="w-aside">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="g-s1">Verify before it reaches me</FieldLabel>
            <Switch id="g-s1" defaultChecked />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="g-s2">Email me every finding</FieldLabel>
            <Switch id="g-s2" />
          </Field>
        </FieldGroup>
      </Lane>
      <Lane label="Select" note={"value 16px · chevron 12 × 8\nempty takes the placeholder, faint\nopen, it is the overlay panel"}>
        <div className="flex w-aside flex-col gap-[28px]">
          <Select items={depths} defaultValue="unit">
            <SelectTrigger aria-label="Verification depth">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unit">Verify every unit</SelectItem>
              <SelectItem value="merged">Verify the merged result only</SelectItem>
              <SelectItem value="request">Verify on request</SelectItem>
              <SelectSeparator />
              <SelectItem value="never" className="text-muted-foreground">
                Never verify
              </SelectItem>
            </SelectContent>
          </Select>
          <Select items={depths} value={depth} onValueChange={setDepth}>
            <SelectTrigger aria-label="Verification depth">
              <SelectValue placeholder="Choose a verification depth" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unit">Verify every unit</SelectItem>
              <SelectItem value="merged">Verify the merged result only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Lane>
    </Sheet>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="6" cy="6" r="4.75" />
      <path d="M9.5 9.5 L13 13" />
    </svg>
  );
}

function Overlays() {
  return (
    <Sheet
      title="Overlay"
      lede="One overlay surface: the same panel carries a menu's options or a popover's content, and the dialog is the floating card promoted. Overlays are transient, so they keep the shadow; nothing else in page flow has one."
    >
      <Lane label="Menu" center note={"panel 16 · pad 8 · item 10+16\nhighlight = surface fill"}>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>Change actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              Open the diff
              <DropdownMenuShortcut>⌥D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>Read the transcript</DropdownMenuItem>
            <DropdownMenuItem>Copy change id</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Close without merging</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Lane>
      <Lane label="Popover" center note={"pad 20 · gap 14 · 400 wide\nsmall buttons only · no tail"}>
        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>Why this split</PopoverTrigger>
          <PopoverContent>
            <Evidence size="xs">a3f19c2 · 4 units</Evidence>
            <PopoverTitle>Why this split</PopoverTitle>
            <PopoverDescription>
              Each unit compiles, tests, and reverts on its own. The auth path
              was left untouched so it stays out of the review surface.
            </PopoverDescription>
            <div className="flex items-center gap-s3 pt-s1">
              <Button variant="flare" size="sm">
                View diff
              </Button>
              <Button variant="outline" size="sm">
                Dismiss
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </Lane>
      <Lane label="Tooltip" center note="ink, flat, no tail">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" />}>Hover or focus me</TooltipTrigger>
            <TooltipContent>Lands by itself once you answer</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Lane>
      <Lane
        label="Dialog"
        center
        note={"600 wide · radius 24\nhead 16+30 · body 30 · foot 20+30\nscrim: ink at 40%, no blur"}
      >
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>Open the question</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <Evidence className="tracking-mono">change · drop legacy webhook path</Evidence>
              <StatusPill>1 question for you</StatusPill>
            </DialogHeader>
            <DialogBody>
              <DialogTitle>
                Unit 3 fails on replay. Drop replay support, or hold the change
                until it passes?
              </DialogTitle>
              <DialogDescription>
                Nothing else in the change depends on replay. Two customers
                called the endpoint last quarter, both from a deprecated SDK.
              </DialogDescription>
            </DialogBody>
            <DialogFooter>
              <Text as="span" size="meta" tone="muted" className="font-regular">
                Recommended: drop it
              </Text>
              <div className="flex items-center gap-s3">
                <DialogClose render={<Button variant="outline" />}>Hold the change</DialogClose>
                <DialogClose render={<Button variant="flare" />}>Drop replay</DialogClose>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Lane>
    </Sheet>
  );
}

const changes = [
  { title: "Add usage-based billing", tone: "flare", status: "1 question", units: "4 / 4 green", claim: "auth path untouched · 7 findings resolved", opened: "2h ago", selected: true },
  { title: "Migrate sessions to Durable Objects", tone: "neutral", status: "Verifying", units: "2 / 6 green", claim: "preview running · 3 findings open", opened: "yesterday", selected: false },
  { title: "Rate-limit counters per tenant", tone: "neutral", status: "Merged", units: "3 / 3 green", claim: "no findings · claims held on preview", opened: "4 days ago", selected: false },
  { title: "Drop the legacy webhook path", tone: "neutral", status: "Blocked", units: "1 / 5 green", claim: "unit 3 fails on replay · needs your call", opened: "6 days ago", selected: false },
] as const;

function Data() {
  return (
    <Sheet
      title="Table and tabs"
      lede="Horizontal hairlines only. No vertical rules, no zebra, no outer border. Machine columns are mono; human columns are not. Tabs sit on the same hairline, the active one in ink."
    >
      <Tabs defaultValue="changes">
        <TabsList>
          <TabsTrigger value="changes">
            Changes <Evidence kind="note" size="xs">4 open</Evidence>
          </TabsTrigger>
          <TabsTrigger value="findings">
            Findings
            <span className="flex items-center gap-[5px]">
              <StatusDot className="size-[5px]" />
              <Evidence size="xs" className="text-flare">
                3 · 1 blocks
              </Evidence>
            </span>
          </TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
        </TabsList>
        <TabsContent value="changes">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[58px]">
                  <Checkbox aria-label="Select all changes" />
                </TableHead>
                <TableHead className="w-[304px]">Change</TableHead>
                <TableHead className="w-[144px]">Status</TableHead>
                <TableHead className="w-[134px]">Units</TableHead>
                <TableHead>Verified claim</TableHead>
                <TableHead className="w-[126px] text-right">Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((change) => (
                <TableRow key={change.title} data-state={change.selected ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox defaultChecked={change.selected} aria-label={`Select ${change.title}`} />
                  </TableCell>
                  <TableCell className="text-ui font-medium text-ink">{change.title}</TableCell>
                  <TableCell className={change.tone === "flare" ? "text-ink" : undefined}>
                    <span className="flex items-center gap-s2">
                      <StatusDot tone={change.tone} />
                      {change.status}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Evidence className="leading-ui tracking-mono">{change.units}</Evidence>
                  </TableCell>
                  <TableCell>{change.claim}</TableCell>
                  <TableCell className="text-right">
                    <Evidence kind="note" className="leading-ui tracking-mono">
                      {change.opened}
                    </Evidence>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="findings">
          <Text tone="muted">Three findings, one of which blocks unit 3.</Text>
        </TabsContent>
        <TabsContent value="decisions">
          <Text tone="muted">Two prior billing decisions apply to this change.</Text>
        </TabsContent>
      </Tabs>
      <div className="flex items-start gap-s11 pt-s10">
        <Text size="detail" tone="muted" className="w-lane shrink-0">
          Loading and scroll
        </Text>
        <div className="flex w-aside flex-col gap-s4">
          <Skeleton className="h-[18px] w-[280px]" />
          <Skeleton className="h-[18px] w-[200px]" />
          <Separator className="my-s2" />
          <ScrollArea className="h-[96px] rounded-chip border-[1.5px] border-border">
            <div className="flex flex-col gap-s1 p-s5">
              {[
                "Change-Intent: 214",
                "Co-authored-by: claude-code <agent@acme>",
                "Reviewed-By: priya",
                "Review-Scope: intent and shape, not implementation",
                "Verified-Claims: 6 of 7",
                "Units: 4",
              ].map((line) => (
                <Evidence key={line}>{line}</Evidence>
              ))}
            </div>
          </ScrollArea>
        </div>
        <Note className="ml-auto w-annotation shrink-0">
          {"Skeleton · Separator · ScrollArea\nthe scroll area is an inset, so it takes a border, not a shadow"}
        </Note>
      </div>
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
    <div className={`flex items-center py-px pr-s2 ${added ? "bg-success-tint" : "bg-surface"}`}>
      <div className="flex w-[22px] shrink-0 items-center pl-[6px]">
        {marked && <div className="h-s5 w-[3px] bg-flare" />}
      </div>
      <span className="type-mono-sm w-[40px] shrink-0 text-right text-faint">{number}</span>
      <span className="type-mono w-[22px] shrink-0 text-center text-success">{added ? "+" : ""}</span>
      <span className={`type-mono grow whitespace-pre ${added ? "text-ink" : "text-muted-foreground"}`}>
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
          <LineThread className="mt-s5 ml-[62px]">
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
      <Cards />
      <Buttons />
      <Statuses />
      <Forms />
      <Overlays />
      <Data />
      <Chat />
      <AskFields />
      <LineThreads />
    </>
  );
}
