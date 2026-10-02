import { TextLink } from "@gitflare/ui/components/typography";
import { createLink } from "@tanstack/react-router";

/**
 * A text link that navigates within the app: the UI package's `TextLink`
 * with the router's typed `to`, `params` and preloading. Use it for every
 * in-app link in running text or a row label; use `TextLink` with `href` only
 * for somewhere outside the app.
 */
export const RouteLink = createLink(TextLink);
