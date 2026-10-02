import { DismissalClass, type ThreadId } from "@gitflare/core";
import { DismissThreadInput } from "@gitflare/core/api";
import { Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@gitflare/ui/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@gitflare/ui/components/ui/radio-group";
import { Textarea } from "@gitflare/ui/components/ui/textarea";
import { useForm } from "@tanstack/react-form";
import { useId } from "react";
import { useDismissThread } from "@/data/threads.queries";
import { dismissalCopy } from "./copy";

/**
 * Dismissing a comment takes a classification and a reason, because the two
 * classes have different consequences: one counts against that kind of
 * finding, the other becomes a decision with the reason as its rationale.
 */
export function DismissForm({ threadId, onDone }: { threadId: ThreadId; onDone: () => void }) {
  const dismiss = useDismissThread();
  const id = useId();
  const form = useForm({
    defaultValues: { classification: "not_a_problem" as DismissalClass, reason: "" },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = DismissThreadInput.safeParse({ threadId, ...value });
        if (parsed.success) return undefined;
        const fields = Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i]));
        if (value.reason.trim() === "") fields.reason = { message: "Say why, in a sentence." };
        return { fields };
      },
    },
    onSubmit: async ({ value }) => {
      try {
        await dismiss.mutateAsync({ threadId, ...value });
      } catch {
        // The mutation holds the refusal; it is shown beside the button.
        return;
      }
      onDone();
    },
  });

  return (
    <form
      aria-label="Dismiss this comment"
      className="max-w-support"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup className="gap-s6">
        <form.Field name="classification">
          {(field) => (
            <FieldSet>
              <FieldLegend variant="label">Dismiss this comment as</FieldLegend>
              <RadioGroup
                value={field.state.value}
                onValueChange={(value) => field.handleChange(DismissalClass.parse(value))}
                className="gap-s4"
              >
                {DismissalClass.options.map((option) => (
                  <Field key={option} orientation="horizontal">
                    <RadioGroupItem value={option} id={`${id}-${option}`} />
                    <FieldContent>
                      <FieldLabel htmlFor={`${id}-${option}`}>
                        {dismissalCopy[option].label}
                      </FieldLabel>
                      <FieldDescription>{dismissalCopy[option].consequence}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
          )}
        </form.Field>
        <form.Field name="reason">
          {(field) => {
            const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
                <Textarea
                  id={`${id}-reason`}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={invalid}
                />
                <form.Subscribe selector={(state) => state.values.classification}>
                  {(classification) => (
                    <FieldDescription>
                      {classification === "design_decision"
                        ? "In your words. It becomes the decision's rationale."
                        : "In your words. It is added to the thread."}
                    </FieldDescription>
                  )}
                </form.Subscribe>
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>
      </FieldGroup>
      <div className="mt-s5 flex flex-wrap items-center gap-x-s5 gap-y-s2">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <>
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? "Dismissing…" : "Dismiss the comment"}
              </Button>
              <Button variant="link" size="xs" disabled={submitting} onClick={onDone}>
                Keep it open
              </Button>
            </>
          )}
        </form.Subscribe>
        {dismiss.error && (
          <Text size="detail" className="text-danger" role="alert">
            {dismiss.error.message}
          </Text>
        )}
      </div>
    </form>
  );
}
