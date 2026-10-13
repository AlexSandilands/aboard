export type Logger = Pick<Console, "warn">;

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
