import {
  EditorContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

import { AttachmentPill } from "~/components/attachments/AttachmentPill";
import { imageFiles } from "~/lib/attachments.logic";
import { cn } from "~/lib/utils";
import { AttachmentNode, richMarkdownExtensions } from "./richMarkdown.extensions";
import {
  docToMarkdown,
  markdownToDocJson,
  markdownToSlice,
  normalizeLineEndings,
  parseAttachmentToken,
  selectionToMarkdown,
  vscodePasteMode,
} from "./richMarkdown.logic";

export interface RichMarkdownEditorHandle {
  /** Puts an "uploading" pill at the cursor, known by `key`. */
  insertUpload: (key: string) => void;
  /** Swaps the upload `key` for the attachment `token` (`![name](attachment:id)`), or removes it when empty. */
  resolveUpload: (key: string, token: string) => void;
}

/** A key the editor didn't handle itself; return true to take it. */
export type EditorKeyHandler = (event: KeyboardEvent) => boolean;

function AttachmentView({ node }: ReactNodeViewProps) {
  const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  return (
    // Keeps the focus in the editor on a click, so it doesn't save and close before the preview opens.
    <NodeViewWrapper as="span" onMouseDown={(event: { preventDefault: () => void }) => event.preventDefault()}>
      <AttachmentPill id={id} name={alt || "image"} />
    </NodeViewWrapper>
  );
}

const extensions = richMarkdownExtensions.map((extension) =>
  extension.name === AttachmentNode.name
    ? AttachmentNode.extend({ addNodeView: () => ReactNodeViewRenderer(AttachmentView, { as: "span" }) })
    : extension,
);

const docJson = (markdown: string) => markdownToDocJson(normalizeLineEndings(markdown));

/**
 * Markdown edited as rich text (TipTap): lists, headings, quotes, code and emphasis show as they will
 * read, typed Markdown turns into them as you type, and pasted images are pills. `value` must pass
 * `canRoundTrip`; `onChange` gets Markdown, and only once the text is edited, so text opened and left
 * alone is never rewritten.
 */
export function RichMarkdownEditor({
  ref,
  value,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  onImages,
  ariaLabel,
  placeholder,
  autoFocus = false,
  className,
}: {
  ref?: Ref<RichMarkdownEditorHandle>;
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: EditorKeyHandler;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Images pasted or dropped in; the caret is already where they go. */
  onImages: (files: File[]) => void;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  // The editor is made once, so its handlers read the latest props from here.
  const props = useRef({ onChange, onKeyDown, onFocus, onBlur, onImages });
  useEffect(() => {
    props.current = { onChange, onKeyDown, onFocus, onBlur, onImages };
  });
  // The Markdown the document was last built from or written to, so a value we sent out isn't loaded back.
  const current = useRef(value);

  const editor = useEditor({
    extensions: [...extensions, Placeholder.configure({ placeholder: placeholder ?? "" })],
    content: docJson(value),
    autofocus: autoFocus ? "end" : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        role: "textbox",
        class: "markdown rich-markdown outline-none",
      },
      handleKeyDown: (view, event) => {
        if (view.composing || event.isComposing) return false;
        return props.current.onKeyDown?.(event) ?? false;
      },
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData?.files ?? []);
        if (files.length > 0) {
          props.current.onImages(files);
          return true;
        }
        // TipTap's code block takes any paste VS Code tags (`vscode-editor-data`) as code; Markdown copied
        // from VS Code is read as Markdown instead, like text from any other app.
        const text = event.clipboardData?.getData("text/plain");
        if (
          !text ||
          vscodePasteMode(event.clipboardData?.getData("vscode-editor-data")) !== "markdown" ||
          view.state.selection.$from.parent.type.spec.code
        ) {
          return false;
        }
        view.dispatch(
          view.state.tr
            .replaceSelection(markdownToSlice(view.state.schema, normalizeLineEndings(text)))
            .scrollIntoView()
            .setMeta("paste", true)
            .setMeta("uiEvent", "paste"),
        );
        return true;
      },
      handleDrop: (view, event, _, moved) => {
        const files = moved ? [] : imageFiles(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
        props.current.onImages(files);
        return true;
      },
      // Pasted text is read as Markdown (ProseMirror keeps it as it is inside a code block). The slice
      // must come from the editor's own schema (it adds Placeholder, so `richMarkdownSchema` is another
      // instance): ProseMirror silently drops a slice built from a different one.
      clipboardTextParser: (text, _, __, view) => markdownToSlice(view.state.schema, text),
      clipboardTextSerializer: (_, view) =>
        selectionToMarkdown(view.state.doc, view.state.selection.from, view.state.selection.to),
    },
    onUpdate: ({ editor: changed }) => {
      const next = docToMarkdown(changed.state.doc);
      if (next === current.current) return;
      current.current = next;
      props.current.onChange(next);
    },
    onFocus: () => props.current.onFocus?.(),
    onBlur: () => props.current.onBlur?.(),
  });

  // A new value from outside (a template filled in, the text cleared after creating a task) is loaded.
  useEffect(() => {
    if (value === current.current) return;
    current.current = value;
    if (docToMarkdown(editor.state.doc) === normalizeLineEndings(value)) return;
    editor.commands.setContent(docJson(value), { emitUpdate: false });
  }, [editor, value]);

  useImperativeHandle(
    ref,
    () => ({
      insertUpload: (key) => {
        editor.chain().focus().insertContent({ type: "attachmentUpload", attrs: { key } }).run();
      },
      resolveUpload: (key, token) => {
        const { state } = editor;
        let at = -1;
        state.doc.descendants((node, pos) => {
          if (at < 0 && node.type.name === "attachmentUpload" && node.attrs.key === key) at = pos;
          return at < 0;
        });
        if (at < 0) return;
        const attachment = parseAttachmentToken(token);
        const tr = attachment
          ? state.tr.replaceWith(at, at + 1, state.schema.nodes.attachment!.create(attachment))
          : state.tr.delete(at, at + 1);
        // Part of the paste that put the pill there, so one undo takes the image out.
        editor.view.dispatch(tr.setMeta("addToHistory", false));
      },
    }),
    [editor],
  );

  return <EditorContent editor={editor} className={cn("min-w-0", className)} />;
}
