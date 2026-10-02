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
      const detail = await create.mutateAsync({ repoSlug, ...value });
      onAdded(detail.decision.id);
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
      <FieldGroup>
        <form.Field name="title">
          {(field) => {
            const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={invalid}
                />
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="statement">
          {(field) => {
            const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={field.name}>Statement</FieldLabel>
                <Textarea
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={invalid}
                />
                <FieldDescription>The rule, as one or two sentences.</FieldDescription>
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="rationale">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Rationale</FieldLabel>
              <Textarea
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldDescription>Why, so a later review knows what it would undo.</FieldDescription>
            </Field>
          )}
        </form.Field>
      </FieldGroup>
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
  wording: { title: string; statement: string; rationale: string };
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
      await edit.mutateAsync({ decisionId, ...value });
      onDone();
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
      <FieldGroup>
        <form.Field name="title">
          {(field) => {
            const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={invalid}
                />
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="statement">
          {(field) => {
            const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={field.name}>Statement</FieldLabel>
                <Textarea
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={invalid}
                />
                <FieldDescription>The rule, as one or two sentences.</FieldDescription>
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="rationale">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Rationale</FieldLabel>
              <Textarea
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldDescription>Why, so a later review knows what it would undo.</FieldDescription>
            </Field>
          )}
        </form.Field>
      </FieldGroup>
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
