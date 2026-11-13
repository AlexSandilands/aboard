import { describe, expect, it } from "vitest";
import { ALERT_TYPES, alertTypeOf, remarkAlerts, type AlertNode } from "./alerts.logic";

const text = (value: string): AlertNode => ({ type: "text", value });
const paragraph = (...children: AlertNode[]): AlertNode => ({ type: "paragraph", children });
const quote = (...children: AlertNode[]): AlertNode => ({ type: "blockquote", children });
const alert = (type: string, ...children: AlertNode[]): AlertNode => ({
  type: "blockquote",
  children,
  data: { hName: "aside", hProperties: { dataAlert: type } },
});
const run = (...children: AlertNode[]) => {
  const tree: AlertNode = { type: "root", children };
  remarkAlerts()(tree);
  return tree.children;
};

describe("remarkAlerts", () => {
  it.each(ALERT_TYPES)("turns a [!%s] quote into an alert and drops the marker line", (type) => {
    expect(run(quote(paragraph(text(`[!${type.toUpperCase()}]\nBody text.`))))).toEqual([
      alert(type, paragraph(text("Body text."))),
    ]);
  });

  it("reads the marker in any case and with trailing spaces", () => {
    expect(run(quote(paragraph(text("[!Warning]  \t\nCareful."))))).toEqual([
      alert("warning", paragraph(text("Careful."))),
    ]);
  });

  it("drops a paragraph left empty and keeps the ones after it", () => {
    const strong: AlertNode = { type: "strong", children: [text("Bold")] };
    expect(run(quote(paragraph(text("[!TIP]\n"), strong), paragraph(text("More."))))).toEqual([
      alert("tip", paragraph(strong), paragraph(text("More."))),
    ]);
    expect(run(quote(paragraph(text("[!NOTE]")), paragraph(text("Next."))))).toEqual([
      alert("note", paragraph(text("Next."))),
    ]);
  });

  it("handles a marker ended by a hard break", () => {
    expect(run(quote(paragraph(text("[!NOTE]"), { type: "break" }, text("Body."))))).toEqual([
      alert("note", paragraph(text("Body."))),
    ]);
  });

  it("makes an empty alert from a marker alone", () => {
    expect(run(quote(paragraph(text("[!CAUTION]"))))).toEqual([alert("caution")]);
  });

  it("finds alerts nested in lists", () => {
    expect(run({ type: "listItem", children: [quote(paragraph(text("[!NOTE]\nIn a list.")))] })).toEqual([
      { type: "listItem", children: [alert("note", paragraph(text("In a list.")))] },
    ]);
  });

  it("leaves other quotes alone", () => {
    const plain = [
      quote(paragraph(text("[!DANGER]\nUnknown type."))),
      quote(paragraph(text("[!NOTE] text on the same line"))),
      quote(paragraph(text("Intro\n[!NOTE]\nNot on the first line."))),
      quote(paragraph(text("[!NOTE]"), { type: "emphasis", children: [text("same line")] })),
      quote(paragraph(text(" [!NOTE]\nIndented."))),
      quote({ type: "code", value: "[!NOTE]" }),
      quote(),
    ];
    expect(run(...structuredClone(plain))).toEqual(plain);
  });
});

describe("alertTypeOf", () => {
  it("accepts the five types only", () => {
    expect(alertTypeOf("note")).toBe("note");
    expect(alertTypeOf("NOTE")).toBeNull();
    expect(alertTypeOf("danger")).toBeNull();
    expect(alertTypeOf(undefined)).toBeNull();
  });
});
