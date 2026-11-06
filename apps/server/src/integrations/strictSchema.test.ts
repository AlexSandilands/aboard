import { describe, expect, it } from "vitest";
import { ASK_OUTPUT_SCHEMA } from "./settingsAsk.ts";
import { REVIEW_OUTPUT_SCHEMA } from "./headlessReview.ts";
import { fromStrict, strictSchema } from "./strictSchema.ts";

describe("strict schemas for Codex", () => {
  it("closes every object, requires every field and makes the optional ones nullable", () => {
    expect(strictSchema(REVIEW_OUTPUT_SCHEMA)).toEqual({
      type: "object",
      properties: {
        summary: REVIEW_OUTPUT_SCHEMA.properties.summary,
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: REVIEW_OUTPUT_SCHEMA.properties.findings.items.properties.severity,
              title: { type: "string" },
              file: { type: ["string", "null"], description: "Repo-relative path." },
              line: { type: ["integer", "null"], minimum: 1 },
              body: { type: ["string", "null"] },
              suggestion: { type: ["string", "null"] },
            },
            required: ["severity", "title", "file", "line", "body", "suggestion"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "findings"],
      additionalProperties: false,
    });
  });

  it("keeps a field that already takes null, and wraps one with no type of its own", () => {
    expect(strictSchema(ASK_OUTPUT_SCHEMA)).toMatchObject({
      properties: { settingId: { type: ["string", "null"] } },
      required: ["settingId", "answer"],
    });
    expect(
      strictSchema({
        type: "object",
        properties: { pick: { enum: ["a", "b"] }, kind: { type: "string", enum: ["x"] } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        pick: { anyOf: [{ enum: ["a", "b"] }, { type: "null" }] },
        kind: { type: ["string", "null"], enum: ["x", null] },
      },
      required: ["pick", "kind"],
      additionalProperties: false,
    });
  });

  it("gives an answer back the original's shape: nulls of optional fields dropped, all else kept", () => {
    const answer = {
      summary: "ok",
      findings: [{ severity: "minor", title: "t", file: null, line: 3, body: null, suggestion: null }],
    };
    expect(fromStrict(REVIEW_OUTPUT_SCHEMA, answer)).toEqual({
      summary: "ok",
      findings: [{ severity: "minor", title: "t", line: 3 }],
    });
    expect(fromStrict(ASK_OUTPUT_SCHEMA, { settingId: null, answer: "a" })).toEqual({ settingId: null, answer: "a" });
  });
});
