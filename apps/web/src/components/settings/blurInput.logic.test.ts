import { describe, expect, it, vi } from "vitest";
import { syncBlurInputDraft } from "./blurInput.logic";

describe("syncBlurInputDraft", () => {
  it("replaces a stale or unsaved draft with an outside update", () => {
    expect(syncBlurInputDraft("", "", "saved remote")).toBe("saved remote");
    expect(syncBlurInputDraft("half edit", "old", "new")).toBe("new");
    expect(syncBlurInputDraft("old", "old", "")).toBe("");
  });

  it("preserves typing when the saved value has not changed", () => {
    expect(syncBlurInputDraft("half edit", "saved", "saved")).toBe("half edit");
  });

  it("does not save the stale empty draft after setup updates the value", () => {
    const value = "https://example.com/backup.git";
    const draft = syncBlurInputDraft("", "", value);
    const onSave = vi.fn<(next: string) => void>();
    if (draft !== value) onSave(draft);
    expect(draft).toBe(value);
    expect(onSave).not.toHaveBeenCalled();
  });
});
