import { Appendix } from "./appendix";
import { Primitives } from "./primitives";
import { System } from "./system";

// A fixed 1440 frame, the width of the Paper artboards, so a screenshot of
// this page lines up with the style guide.
export function Gallery() {
  return (
    <main className="mx-auto w-frame bg-ground">
      <System />
      <div className="mx-13 mt-15 border-t border-rule" />
      <Primitives />
      <Appendix />
    </main>
  );
}
