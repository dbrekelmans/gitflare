import { AskField } from "@gitflare/ui/components/chat";
import { Text } from "@gitflare/ui/components/typography";
import { FieldError } from "@gitflare/ui/components/ui/field";
import { useForm } from "@tanstack/react-form";

/** What a schema's `safeParse` returns, as far as a form reads it. */
type Parsed =
  | { success: true }
  | { success: false; error: { issues: readonly { message: string }[] } };

/**
 * The one-line field a message enters through: a reply to a thread, or the
 * question that starts a chat. The operation's input schema validates on
 * submit; the field empties once the message has been sent and the thread has
 * refetched.
 */
export function AskForm({
  label,
  placeholder,
  size = "inline",
  scope,
  parse,
  send,
  error,
}: {
  /** The field's accessible name. */
  label: string;
  placeholder: string;
  size?: "page" | "inline";
  scope?: string;
  /** The operation's input schema applied to this body. */
  parse: (body: string) => Parsed;
  /** A mutation hook's `mutateAsync`. */
  send: (body: string) => Promise<unknown>;
  /** The mutation's error: the server's refusal. */
  error: Error | null;
}) {
  const form = useForm({
    defaultValues: { body: "" },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = parse(value.body);
        if (parsed.success) return undefined;
        const message =
          value.body.trim() === ""
            ? "Write a message first."
            : (parsed.error.issues[0]?.message ?? "This message cannot be sent.");
        return { fields: { body: { message } } };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await send(value.body);
      } catch {
        // The mutation holds the refusal; it is shown under the field and the text is kept.
        return;
      }
      formApi.reset();
    },
  });

  return (
    <div className="flex flex-col gap-s2">
      <form.Field name="body">
        {(field) => {
          const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(submitting) => (
                  <AskField
                    size={size}
                    scope={scope}
                    name={field.name}
                    aria-label={label}
                    aria-invalid={invalid}
                    placeholder={placeholder}
                    autoComplete="off"
                    readOnly={submitting}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onSubmit={() => {
                      if (!submitting) void form.handleSubmit();
                    }}
                  />
                )}
              </form.Subscribe>
              {invalid && <FieldError errors={field.state.meta.errors} />}
            </>
          );
        }}
      </form.Field>
      {error && (
        <Text size="detail" className="text-danger" role="alert">
          {error.message}
        </Text>
      )}
    </div>
  );
}
