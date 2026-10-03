import { createFileRoute } from "@tanstack/react-router";
import { NewRepository } from "./-components/new";

export const Route = createFileRoute("/repos/new")({
  component: NewRepository,
});
