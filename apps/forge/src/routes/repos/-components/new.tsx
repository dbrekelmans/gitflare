import { CreateRepositoryInput } from "@gitflare/core/api";
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
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { PageHead } from "@/components/shell/page";
import { useCreateRepository } from "@/data/repositories.queries";

// The reference form. Every form in the app is written this way:
//
// - `useForm` from TanStack Form, with the operation's own input schema from
//   `@gitflare/core/api` as the submit validator, so the browser and the
//   server function check the same thing;
// - one `form.Field` per input, rendered with the `Field` family from the UI
//   package, showing errors once the field has been touched;
// - `onSubmit` awaits a mutation hook from `src/data`, never a server
//   function directly, and navigates only after it resolves;
// - the mutation's error, which is the server's refusal, is shown beside the
//   submit button.
export function NewRepository() {
  const navigate = useNavigate();
  const create = useCreateRepository();
  const form = useForm({
    defaultValues: { slug: "", description: "", importUrl: "" },
    validators: {
      onSubmit: ({ value }) => {
        const parsed = CreateRepositoryInput.safeParse(toInput(value));
        if (parsed.success) return undefined;
        return { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i])) };
      },
    },
    onSubmit: async ({ value }) => {
      // Only the mutation's failure is shown beside the submit button, via
      // `create.error`; a navigation failure after a successful create must
      // not be swallowed with it.
      const view = await create.mutateAsync(toInput(value)).catch(() => undefined);
      if (!view) return;
      await navigate({ to: "/repos/$repoSlug", params: { repoSlug: view.repository.slug } });
    },
  });

  return (
    <>
      <PageHead
        title="New repository"
        lede="Start empty, or import a public repository. Gitflare checks it fits before importing."
      />
      <form
        className="max-w-support"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="slug">
            {(field) => {
              const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={invalid}
                    autoComplete="off"
                    placeholder="atlas-web"
                  />
                  <FieldDescription>Lowercase letters, digits and hyphens.</FieldDescription>
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Description</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="importUrl">
            {(field) => {
              const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor={field.name}>Import from</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={invalid}
                    placeholder="https://github.com/acme/atlas-web.git"
                  />
                  <FieldDescription>Optional. A public HTTPS git URL.</FieldDescription>
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>
        </FieldGroup>
        <div className="mt-s8 flex items-center gap-s6">
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create repository"}
              </Button>
            )}
          </form.Subscribe>
          {create.error && (
            <Text size="detail" className="text-danger" role="alert">
              {create.error.message}
            </Text>
          )}
        </div>
      </form>
    </>
  );
}

function toInput(value: { slug: string; description: string; importUrl: string }) {
  return {
    slug: value.slug,
    description: value.description,
    importUrl: value.importUrl.trim() === "" ? undefined : value.importUrl.trim(),
  };
}
