import Markdown from "react-markdown";

/**
 * A message's Markdown, set inside a `ChatTurn`, which supplies the type.
 * Identifiers in backticks are the code's own names, so they are the one
 * thing here set in mono.
 */
export function MessageBody({ children }: { children: string }) {
  return (
    <Markdown
      components={{
        p: ({ children }) => <p className="mt-s3 first:mt-0">{children}</p>,
        code: ({ children }) => (
          <code className="font-mono text-[0.875em] wrap-anywhere">{children}</code>
        ),
        pre: ({ children }) => (
          <pre className="mt-s3 overflow-x-auto border-y border-rule py-s3 first:mt-0">
            {children}
          </pre>
        ),
        strong: ({ children }) => <strong className="font-medium">{children}</strong>,
        a: ({ children, href }) => (
          <a href={href} className="underline decoration-1 underline-offset-[3px]">
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="mt-s3 list-disc pl-s6 first:mt-0">{children}</ul>,
        ol: ({ children }) => <ol className="mt-s3 list-decimal pl-s6 first:mt-0">{children}</ol>,
      }}
    >
      {children}
    </Markdown>
  );
}
