// Everything that needs TipTap, loaded on its own (see loadRichEditor).
import { richMarkdownSchema } from "./richMarkdown.extensions";
import { canRoundTrip } from "./richMarkdown.logic";

export { RichMarkdownEditor } from "./RichMarkdownEditor";

/** Whether `text` can be edited as rich text (see canRoundTrip). */
export const fitsRichEditor = (text: string): boolean => canRoundTrip(richMarkdownSchema, text);
