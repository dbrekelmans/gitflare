import { Logo } from "@gitflare/ui/components/logo";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { accountQueries } from "@/data/account.queries";
import { formatUsd } from "@/lib/format";

const destinations = [
  { to: "/", label: "Inbox", exact: true },
  { to: "/repos", label: "Repositories", exact: false },
  { to: "/sessions", label: "Sessions", exact: false },
  { to: "/settings", label: "Settings", exact: false },
] as const;

/**
 * The frame every screen sits in: the mark, where you can go, and on the
 * right, quieter, what the deployment has spent and who you are. One hairline
 * under it; the page below owns everything else, including its own width.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { data: me } = useSuspenseQuery(accountQueries.me());
  return (
    <div className="min-h-dvh bg-ground">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-frame items-center gap-s10 px-s13">
          <Link to="/" aria-label="gitflare, inbox" className="shrink-0">
            <Logo size={20} />
          </Link>
          <nav aria-label="Main" className="flex shrink-0 items-center gap-s7">
            {destinations.map((destination) => (
              <Link
                key={destination.to}
                to={destination.to}
                activeOptions={{ exact: destination.exact }}
                className="type-meta whitespace-nowrap text-muted-foreground transition-colors hover:text-ink data-[status=active]:text-ink"
              >
                {destination.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-baseline gap-s7">
            <Evidence size="sm" kind="note" className="hidden whitespace-nowrap lg:inline-flex">
              {formatUsd(me.budget.spentMicroUsd)} of {formatUsd(me.budget.budgetMicroUsd)} this
              month
            </Evidence>
            <Text as="span" size="meta" tone="muted" className="truncate">
              {me.user.name}
            </Text>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-frame px-s13 pt-s12 pb-s15">{children}</main>
    </div>
  );
}
