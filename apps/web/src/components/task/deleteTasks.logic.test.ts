import { describe, expect, it } from "vitest";
import { deleteConfirmText, deletedToastTitle, epicTasksLabel } from "./deleteTasks.logic";

const task = (number: number, kind: "task" | "epic" = "task") => ({
  id: `t${number}`,
  number,
  title: `Task ${number}`,
  kind,
});

describe("deleteConfirmText", () => {
  it("names one task and says how long the trash keeps it", () => {
    expect(deleteConfirmText([task(4)], 30)).toEqual({
      title: "Delete #4?",
      description:
        '"Task 4" goes to the trash with its plan, links and activity. You can restore it from Settings → Recently deleted for 30 days.',
      confirmLabel: "Delete",
    });
  });

  it("says an epic's tasks stay unless they go with it", () => {
    expect(deleteConfirmText([task(5, "epic")], 30).description).toMatch(/its tasks stay on the board unless they go/);
  });

  it("counts several tasks", () => {
    const text = deleteConfirmText([task(1), task(2)], 1);
    expect(text.title).toBe("Delete 2 tasks?");
    expect(text.confirmLabel).toBe("Delete 2 tasks");
    expect(text.description).toMatch(/for 1 day\.$/);
  });
});

describe("epicTasksLabel", () => {
  it("asks only for one epic that has tasks", () => {
    expect(epicTasksLabel([task(1, "epic")], 3)).toBe("Also delete its 3 tasks");
    expect(epicTasksLabel([task(1, "epic")], 1)).toBe("Also delete its task");
    expect(epicTasksLabel([task(1, "epic")], 0)).toBeNull();
    expect(epicTasksLabel([task(1)], 3)).toBeNull();
    expect(epicTasksLabel([task(1, "epic"), task(2)], 3)).toBeNull();
  });
});

describe("deletedToastTitle", () => {
  it("says what went", () => {
    expect(deletedToastTitle([task(4)], ["t4"])).toBe("Deleted #4");
    expect(deletedToastTitle([task(4, "epic")], ["t4", "a", "b"])).toBe("Deleted #4 and its 2 tasks");
    expect(deletedToastTitle([task(4, "epic")], ["t4", "a"])).toBe("Deleted #4 and its 1 task");
    expect(deletedToastTitle([task(1), task(2)], ["t1", "t2"])).toBe("Deleted 2 tasks");
  });
});
