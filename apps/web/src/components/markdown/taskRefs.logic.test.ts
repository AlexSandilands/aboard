import { describe, expect, it } from "vitest";
import { remarkTaskRefs, taskRefNumber, type MdNode } from "./taskRefs.logic";

const text = (value: string): MdNode => ({ type: "text", value });
const ref = (n: number): MdNode => ({ type: "link", url: `#task-${n}`, children: [text(`#${n}`)] });
const run = (children: MdNode[], known: number[] = [42]) => {
  const tree: MdNode = { type: "root", children };
  remarkTaskRefs((n) => known.includes(n))(tree);
  return tree.children;
};

describe("remarkTaskRefs", () => {
  it("links a known number and keeps the text around it", () => {
    expect(run([{ type: "paragraph", children: [text("Moved #42 to Done.")] }])).toEqual([
      { type: "paragraph", children: [text("Moved "), ref(42), text(" to Done.")] },
    ]);
  });

  it("links several, including at the ends of the text", () => {
    expect(run([{ type: "paragraph", children: [text("#42, #7")] }], [42, 7])).toEqual([
      { type: "paragraph", children: [ref(42), text(", "), ref(7)] },
    ]);
  });

  it("leaves a number that isn't a task on the board as text", () => {
    const paragraph: MdNode = { type: "paragraph", children: [text("See #99 and #42")] };
    expect(run([paragraph])).toEqual([{ type: "paragraph", children: [text("See #99 and "), ref(42)] }]);
    expect(run([{ type: "paragraph", children: [text("See #99")] }])).toEqual([
      { type: "paragraph", children: [text("See #99")] },
    ]);
  });

  it("works inside emphasis and list items", () => {
    expect(run([{ type: "listItem", children: [{ type: "strong", children: [text("#42")] }] }])).toEqual([
      { type: "listItem", children: [{ type: "strong", children: [ref(42)] }] },
    ]);
  });

  it("doesn't touch code, links, or things that only look like a number reference", () => {
    const literal: MdNode[] = [
      { type: "inlineCode", value: "#42" },
      { type: "code", value: "#42" },
      { type: "link", url: "https://example.com", children: [text("#42")] },
    ];
    expect(run(literal)).toEqual(literal);
    for (const value of ["v#42", "##42", "#42abc", "&#42;", "a/#42", "#", "# 42"]) {
      expect(run([{ type: "paragraph", children: [text(value)] }])).toEqual([
        { type: "paragraph", children: [text(value)] },
      ]);
    }
  });
});

describe("taskRefNumber", () => {
  it("reads the number from a task reference href only", () => {
    expect(taskRefNumber("#task-42")).toBe(42);
    expect(taskRefNumber("#task-")).toBeNull();
    expect(taskRefNumber("#task-4x")).toBeNull();
    expect(taskRefNumber("https://example.com/#task-4")).toBeNull();
    expect(taskRefNumber(undefined)).toBeNull();
  });
});
