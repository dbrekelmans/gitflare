import { createCn } from "cn/config"

const steps = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`)

/**
 * shadcn's `cn`, taught Gitflare's theme: without this, `text-ui` (a size)
 * and `text-ink` (a colour) would be treated as the same property and one
 * would silently drop the other.
 */
export const cn = createCn({
  extend: {
    theme: {
      font: ["display"],
      text: [
        "mono-xs",
        "detail",
        "meta",
        "ui",
        "body",
        "body-m",
        "title",
        "body-l",
        "statement",
        "lede",
        "display-s",
        "display-m",
        "display-l",
        "display-xl",
      ],
      "font-weight": ["regular"],
      tracking: [
        "display",
        "wordmark",
        "lede",
        "heading",
        "mono",
        "status",
        "caps",
      ],
      leading: [
        "mono-xs",
        "xs",
        "ui",
        "mono",
        "body-s",
        "body",
        "body-m",
        "body-l",
        "lede",
        "display-s",
        "display-m",
        "display-l",
        "display-xl",
      ],
      container: [
        "control",
        "lane",
        "label",
        "annotation",
        "aside",
        "support",
        "body",
        "claim",
        "opener",
        "card",
        "content",
        "hero",
        "frame",
      ],
      spacing: steps("s", 18),
      radius: ["control", "chip", "panel", "card", "pill"],
      shadow: ["floating"],
    },
    classGroups: {
      // The composite type-scale utilities from theme.css.
      type: [
        {
          type: [
            "display-xl",
            "display-l",
            "display-m",
            "display-s",
            "lede",
            "statement",
            "title",
            "body-l",
            "body-m",
            "body",
            "body-s",
            "detail",
            "ui",
            "meta",
            "mono",
            "mono-sm",
            "mono-xs",
          ],
        },
      ],
    },
    conflictingClassGroups: {
      type: ["font-family", "font-size", "leading", "font-weight", "tracking"],
    },
  },
})
