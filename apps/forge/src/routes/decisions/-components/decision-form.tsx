import type { DecisionId } from "@gitflare/core";
import { CreateDecisionInput, EditDecisionInput } from "@gitflare/core/api";
import { Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@gitflare/ui/components/ui/field";
import { Input } from "@gitflare/ui/components/ui/input";
import { Textarea } from "@gitflare/ui/components/ui/textarea";
import { useForm } from "@tanstack/react-form";
import { useCreateDecision, useEditDecision } from "@/data/decisions.queries";

type Wording = { title: string; statement: string; rationale: string };

type FieldState = {
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  errors: Array<{ message?: string } | undefined>;
};

/** The three fields every decision has, shared between adding one and editing one. */
function WordingFields({
  title,
  statement,
  rationale,
}: {
  title: FieldState;
  statement: FieldState;
  rationale: FieldState;
}) {
  return (
    <FieldGroup>
      <Field data-invalid={title.invalid}>
        <FieldLabel htmlFor="decision-title">Title</FieldLabel>
        <Input
          id="decision-title"
          name="title"
          value={title.value}
          onBlur={title.onBlur}
          onChange={(event) => title.onChange(event.target.value)}
          aria-invalid={title.invalid}
        />
        {title.invalid && <FieldError errors={title.errors} />}
      </Field>
      <Field data-invalid={statement.invalid}>
        <FieldLabel htmlFor="decision-statement">Statement</FieldLabel>
        <Textarea
          id="decision-statement"
          name="statement"
          value={statement.value}
          onBlur={statement.onBlur}
          onChange={(event) => statement.onChange(event.target.value)}
          aria-invalid={statement.invalid}
        />
        <FieldDescription>The rule, as one or two sentences.</FieldDescription>
        {statement.invalid && <FieldError errors={statement.errors} />}
      </Field>
      <Field data-invalid={rationale.invalid}>
        <FieldLabel htmlFor="decision-rationale">Rationale</FieldLabel>
        <Textarea
          id="decision-rationale"
          name="rationale"
          value={rationale.value}
          onBlur={rationale.onBlur}
          onChange={(event) => rationale.onChange(event.target.value)}
          aria-invalid={rationale.invalid}
        />
        <FieldDescription>Why, so a later review knows what it would undo.</FieldDescription>
        {rationale.invalid && <FieldError errors={rationale.errors} />}
      </Field>
    </FieldGroup>
  );
}

/** Adds a decision by hand, rather than one gitflare recorded from a review. */
export function AddDecisionForm({
  repoSlug,
  onAdded,
  onCancel,
}: {
  repoSlug: string;
  onAdded: (decisionId: DecisionId) => void;
  onCancel: () => void;
}) {
  const create = useCreateDecision();
  const form = useForm({
    defaultValues: { title: "", statement: "", rationale: "" },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = CreateDecisionInput.safeParse({ repoSlug, ...value });
        if (parsed.success) return undefined;
        return { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i])) };
      },
    },
    onSubmit: async ({ value }) => {
      // mutateAsync rejects on failure; the mutation's own `error` state (read
      // below) is what the form shows, so a rejection here only needs catching.
      try {
        const detail = await create.mutateAsync({ repoSlug, ...value });
        onAdded(detail.decision.id);
      } catch {
        // handled by `create.error`
      }
    },
  });

  return (
    <form
      className="max-w-support"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="title">
        {(title) => (
          <form.Field name="statement">
            {(statement) => (
              <form.Field name="rationale">
                {(rationale) => (
                  <WordingFields
                    title={{
                      value: title.state.value,
                      invalid: title.state.meta.isTouched && !title.state.meta.isValid,
                      onChange: title.handleChange,
                      onBlur: title.handleBlur,
                      errors: title.state.meta.errors,
                    }}
                    statement={{
                      value: statement.state.value,
                      invalid: statement.state.meta.isTouched && !statement.state.meta.isValid,
                      onChange: statement.handleChange,
                      onBlur: statement.handleBlur,
                      errors: statement.state.meta.errors,
                    }}
                    rationale={{
                      value: rationale.state.value,
                      invalid: rationale.state.meta.isTouched && !rationale.state.meta.isValid,
                      onChange: rationale.handleChange,
                      onBlur: rationale.handleBlur,
                      errors: rationale.state.meta.errors,
                    }}
                  />
                )}
              </form.Field>
            )}
          </form.Field>
        )}
      </form.Field>
      <div className="mt-s8 flex items-center gap-s6">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" variant="flare" disabled={submitting}>
              {submitting ? "Adding…" : "Add decision"}
            </Button>
          )}
        </form.Subscribe>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {create.error && (
          <Text size="detail" className="text-danger" role="alert">
            {create.error.message}
          </Text>
        )}
      </div>
    </form>
  );
}

/** Corrects a decision's wording. Recorded as a `reshaped` event, never as a silent overwrite. */
export function EditDecisionForm({
  decisionId,
  wording,
  onDone,
  onCancel,
}: {
  decisionId: DecisionId;
  wording: Wording;
  onDone: () => void;
  onCancel: () => void;
}) {
  const edit = useEditDecision();
  const form = useForm({
    defaultValues: wording,
    validators: {
      onSubmit: ({ value }) => {
        const parsed = EditDecisionInput.safeParse({ decisionId, ...value });
        if (parsed.success) return undefined;
        return { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i])) };
      },
    },
    onSubmit: async ({ value }) => {
      try {
        await edit.mutateAsync({ decisionId, ...value });
        onDone();
      } catch {
        // handled by `edit.error`
      }
    },
  });

  return (
    <form
      className="max-w-support"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="title">
        {(title) => (
          <form.Field name="statement">
            {(statement) => (
              <form.Field name="rationale">
                {(rationale) => (
                  <WordingFields
                    title={{
                      value: title.state.value,
                      invalid: title.state.meta.isTouched && !title.state.meta.isValid,
                      onChange: title.handleChange,
                      onBlur: title.handleBlur,
                      errors: title.state.meta.errors,
                    }}
                    statement={{
                      value: statement.state.value,
                      invalid: statement.state.meta.isTouched && !statement.state.meta.isValid,
                      onChange: statement.handleChange,
                      onBlur: statement.handleBlur,
                      errors: statement.state.meta.errors,
                    }}
                    rationale={{
                      value: rationale.state.value,
                      invalid: rationale.state.meta.isTouched && !rationale.state.meta.isValid,
                      onChange: rationale.handleChange,
                      onBlur: rationale.handleBlur,
                      errors: rationale.state.meta.errors,
                    }}
                  />
                )}
              </form.Field>
            )}
          </form.Field>
        )}
      </form.Field>
      <div className="mt-s8 flex items-center gap-s6">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          )}
        </form.Subscribe>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {edit.error && (
          <Text size="detail" className="text-danger" role="alert">
            {edit.error.message}
          </Text>
        )}
      </div>
    </form>
  );
}
