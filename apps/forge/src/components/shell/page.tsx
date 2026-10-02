import { Evidence, Heading, Text } from "@gitflare/ui/components/typography";
import type { ReactNode } from "react";

/**
 * The top of a page: what it is, in one line, and one sentence under it.
 * `aside` sits on the right, for the page's primary action or its status.
 */
export function PageHead({
  title,
  lede,
  aside,
}: {
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-s11 pb-s11">
      <div className="max-w-claim">
        <Heading level={1} size="display-s">
          {title}
        </Heading>
        {lede != null && (
          <Text size="body-l" tone="muted" className="mt-s5">
            {lede}
          </Text>
        )}
      </div>
      {aside != null && <div className="shrink-0 pt-s3">{aside}</div>}
    </div>
  );
}

/**
 * Marks a screen the scaffold only sketched. It names the build task that
 * owns the route, so whoever opens the page knows where the real one comes
 * from. Delete it from a route when that route is built.
 */
export function Unbuilt({ task }: { task: string }) {
  return (
    <div className="mt-s13 border-t border-rule pt-s6">
      <Text size="detail" tone="faint">
        This screen is a placeholder. It shows that the route, its data and the design system are
        wired; the screen itself is built by the task below.
      </Text>
      <Evidence size="sm" kind="note" className="mt-s2 block">
        build task: {task}
      </Evidence>
    </div>
  );
}
