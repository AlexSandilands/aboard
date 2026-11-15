import { describe, expect, it } from "vitest";
import { remarkTaskRefs, taskRefNumber, type MdNode } from "./taskRefs.logic";

const text = (value: string): MdNode => ({ type: "text", value });
const ref = (n: number | string): MdNode => ({ type: "link", url: `#task-${n}`, children: [text(`#${n}`)] });
const run = (children: MdNode[], known: Array<number | string> = [42]) => {
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

describe("a task a machine numbered", () => {
  it("is linked by its prefix and number, in any case, and never taken for the board's own number", () => {
    const linked = run([{ type: "paragraph", children: [text("See #E7 and #e7, not #7 or #E8.")] }], ["E7"]);
    expect(linked).toEqual([
      {
        type: "paragraph",
        children: [
          text("See "),
          ref("E7"),
          text(" and "),
          { type: "link", url: "#task-E7", children: [text("#e7")] },
          text(", not #7 or #E8."),
        ],
      },
    ]);
    expect(taskRefNumber("#task-E7")).toBe("E7");
    expect(taskRefNumber("#task-e7")).toBeNull();
  });

  it("leaves a colour or an anchor that only looks like one as text", () => {
    const untouched = [{ type: "paragraph", children: [text("Use #fff or #abc123, see #section2.")] }];
    expect(run(untouched, ["E7"])).toEqual(untouched);
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
