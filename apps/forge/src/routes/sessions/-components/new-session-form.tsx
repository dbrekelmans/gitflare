import { StartSessionInput } from "@gitflare/core/api";
import { Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@gitflare/ui/components/ui/field";
import { Input } from "@gitflare/ui/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@gitflare/ui/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@gitflare/ui/components/ui/select";
import { Textarea } from "@gitflare/ui/components/ui/textarea";
import { useForm } from "@tanstack/react-form";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { repositoryQueries } from "@/data/repositories.queries";
import { useStartSession } from "@/data/sessions.queries";

function toInput(value: {
  repoSlug: string;
  kind: "local" | "cloud";
  title: string;
  prompt: string;
}) {
  return {
    repoSlug: value.repoSlug,
    kind: value.kind,
    title: value.title,
    prompt: value.kind === "cloud" ? value.prompt : undefined,
  };
}

/** A required field reads better as a plain sentence than as the schema's own wording. */
function requiredMessage(value: string, errors: Array<{ message?: string } | undefined>) {
  return value.trim() === "" ? [{ message: "Required." }] : errors;
}

// Written like `routes/repos/new.tsx`: the operation's own input schema
// validates on submit, and the mutation's refusal shows beside the button.
export function NewSessionForm() {
  const navigate = useNavigate();
  const { data: repositories } = useSuspenseQuery(repositoryQueries.list());
  const start = useStartSession();
  const form = useForm({
    defaultValues: {
      repoSlug: repositories[0]?.repository.slug ?? "",
      kind: "local" as "local" | "cloud",
      title: "",
      prompt: "",
    },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = StartSessionInput.safeParse(toInput(value));
        if (parsed.success) return undefined;
        return { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i])) };
      },
    },
    onSubmit: async ({ value }) => {
      const view = await start.mutateAsync(toInput(value));
      await navigate({ to: "/sessions/$sessionId", params: { sessionId: view.session.id } });
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
        <form.Field name="repoSlug">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Repository</FieldLabel>
              <Select
                items={repositories.map((r) => ({
                  value: r.repository.slug,
                  label: r.repository.slug,
                }))}
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value ?? "")}
              >
                <SelectTrigger id={field.name} variant="framed">
                  <SelectValue placeholder="Choose a repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((r) => (
                    <SelectItem key={r.repository.id} value={r.repository.slug}>
                      {r.repository.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>

        <form.Field name="kind">
          {(field) => (
            <FieldSet>
              <FieldLegend variant="label">Where it runs</FieldLegend>
              <RadioGroup
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value as "local" | "cloud")}
              >
                <Field orientation="horizontal">
                  <RadioGroupItem value="local" id="kind-local" />
                  <FieldLabel htmlFor="kind-local" className="font-normal">
                    Local — you push to the fork yourself
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="cloud" id="kind-cloud" />
                  <FieldLabel htmlFor="kind-cloud" className="font-normal">
                    Hosted — an agent works the fork from a prompt
                  </FieldLabel>
                </Field>
              </RadioGroup>
            </FieldSet>
          )}
        </form.Field>

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
                  placeholder="Rate-limit the invite endpoint"
                />
                {invalid && (
                  <FieldError
                    errors={requiredMessage(field.state.value, field.state.meta.errors)}
                  />
                )}
              </Field>
            );
          }}
        </form.Field>

        <form.Subscribe selector={(state) => state.values.kind}>
          {(kind) =>
            kind === "cloud" && (
              <form.Field name="prompt">
                {(field) => {
                  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor={field.name}>First instruction</FieldLabel>
                      <Textarea
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={invalid}
                        placeholder="What should the agent do first?"
                      />
                      <FieldDescription>
                        The agent's first turn, once the workspace is ready.
                      </FieldDescription>
                      {invalid && (
                        <FieldError
                          errors={requiredMessage(field.state.value, field.state.meta.errors)}
                        />
                      )}
                    </Field>
                  );
                }}
              </form.Field>
            )
          }
        </form.Subscribe>
      </FieldGroup>
      <div className="mt-s8 flex items-center gap-s6">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button
              type="submit"
              variant="flare"
              disabled={submitting || repositories.length === 0}
            >
              {submitting ? "Starting…" : "Start session"}
            </Button>
          )}
        </form.Subscribe>
        {start.error && (
          <Text size="detail" className="text-danger" role="alert">
            {start.error.message}
          </Text>
        )}
      </div>
      {repositories.length === 0 && (
        <Text size="detail" tone="muted" className="mt-s4">
          There is no repository to fork yet.
        </Text>
      )}
    </form>
  );
}
