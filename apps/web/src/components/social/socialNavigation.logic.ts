/** Whether Back from the feed steps back in history (opened from Settings) rather than going to the board. */
export function shouldStepBack(state: { socialFromSettings?: boolean }, canGoBack: boolean): boolean {
  return Boolean(state.socialFromSettings) && canGoBack;
}
