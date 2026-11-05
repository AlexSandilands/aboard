/** Outside updates replace even an unsaved edit; unchanged props preserve typing. */
export function syncBlurInputDraft(draft: string, seenValue: string, value: string): string {
  return value !== seenValue ? value : draft;
}
