import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Row } from "./row";

afterEach(cleanup);

describe("Row", () => {
  it("stacks label, description and annotation in a column below 1024px, and lays them out in a row at and above it", () => {
    render(
      <Row label="Claim" annotation="evidence">
        description
      </Row>,
    );
    const row = screen.getByText("Claim").parentElement;
    if (!row) throw new Error("the row has no wrapper element");
    expect(row.className).toContain("flex-col");
    expect(row.className).toContain("lg:flex-row");
  });

  it("renders the label, the description and the annotation", () => {
    render(
      <Row label="Claim" annotation="evidence">
        description
      </Row>,
    );
    expect(screen.getByText("Claim")).toBeTruthy();
    expect(screen.getByText("description")).toBeTruthy();
    expect(screen.getByText("evidence")).toBeTruthy();
  });

  it("renders no annotation column when none is given", () => {
    render(<Row label="Claim">description</Row>);
    expect(screen.queryByText("evidence")).toBeNull();
  });
});
