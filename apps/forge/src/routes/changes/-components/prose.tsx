import { cn } from "@gitflare/ui/lib/utils";
import Markdown from "react-markdown";

/**
 * A section's explanation: Markdown the sectioning agent wrote for a reader
 * who has not opened the diff. Identifiers in backticks are the code's own
 * names, so they are the one thing here set in mono.
 */
export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-s3", className)}>
      <Markdown
        components={{
          p: ({ children }) => <p className="type-body text-muted-foreground">{children}</p>,
          code: ({ children }) => (
            <code className="font-mono text-[0.875em] text-ink">{children}</code>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
