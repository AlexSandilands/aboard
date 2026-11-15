// A task's number as people and agents see it (docs/features/task-lifecycle.md#numbering): `#42` for a task the
// board numbered, `#E7` for one a connected machine made while the board couldn't be reached. The prefix and the
// number are two fields everywhere, so sorting and lookups stay numeric.

/** Anything that carries a task's number. A missing prefix is a task the board numbered. */
export interface NumberedTask {
  number: number;
  numberPrefix?: string | null | undefined;
}

/** `42` or `E7`: the number without the hash, for branch names, file names and activity payloads. */
export const taskNumberText = (task: NumberedTask): string => `${task.numberPrefix ?? ""}${task.number}`;

/** `#42` or `#E7`. */
export const taskLabel = (task: NumberedTask): string => `#${taskNumberText(task)}`;

/**
 * What an activity entry stores for another task's number: the number itself for a task the board numbered, as it
 * always was, and the text (`E7`) for a prefixed one, so `#${payload.task}` reads right for both.
 */
export const taskNumberValue = (task: NumberedTask): number | string =>
  task.numberPrefix ? taskNumberText(task) : task.number;

const MACHINE_PREFIX = /^[A-Z][A-Z0-9]{0,2}$/;

/**
 * The numbers a reference may mean: `#42` and `42` are one; `#E7` and `e7` are one. A prefix may hold digits, so
 * `E27` reads as `E` 27 or `E2` 7: both are returned, shortest prefix first, and the caller takes the first that is a
 * task. Empty for anything else (a uuid).
 */
export function parseTaskNumberRef(ref: string): Array<{ prefix: string; number: number }> {
  const text = ref.trim().replace(/^#/, "").toUpperCase();
  const candidates: Array<{ prefix: string; number: number }> = [];
  for (let split = 0; split <= 3 && split < text.length; split++) {
    const prefix = text.slice(0, split);
    const digits = text.slice(split);
    if ((split > 0 && !MACHINE_PREFIX.test(prefix)) || !/^\d+$/.test(digits)) continue;
    const number = Number(digits);
    if (Number.isSafeInteger(number)) candidates.push({ prefix, number });
  }
  return candidates;
}

/** Orders tasks by number: the board's own first, then each prefix's. */
export const compareTaskNumbers = (a: NumberedTask, b: NumberedTask): number =>
  (a.numberPrefix ?? "").localeCompare(b.numberPrefix ?? "") || a.number - b.number;

/**
 * A task's number as an activity entry stored it (see `taskNumberValue`): `42` or `E7` as text, or null for anything
 * else. For rendering `#${...}` from a payload, which is untyped.
 */
export function storedTaskNumber(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return typeof value === "string" && /^[A-Z][A-Z0-9]{0,2}\d+$/.test(value) ? value : null;
}
