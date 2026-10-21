// Adapted from T3 Code (MIT) — see NOTICE.
import { deriveProjectIdentity, ProjectIcon, type ProjectIconColor } from "@repo/contracts";
import { ProjectMonogram } from "./ProjectMonogram";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { IconImageError, imageFileToIconDataUrl } from "./projectIconImage";
import {
  filterProjectIconNames,
  firstEmoji,
  PROJECT_EMOJIS,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "./projectIconOptions";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { iconCandidateSrc } from "~/lib/api";
import { useIconCandidates } from "~/state/queries";

const DEFAULT_ICON: IconName = "folder-code";

function isMonogramText(text: string, color: ProjectIconColor): boolean {
  return ProjectIcon.safeParse({ kind: "monogram", text, color }).success;
}

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ProjectIconPickerDialog({
  projectId = null,
  title,
  value: current,
  open,
  onOpenChange,
  onSave,
}: {
  /** The project whose folder is searched for images to offer; without one the Image tab has no suggestions. */
  readonly projectId?: string | null;
  readonly title: string;
  readonly value: ProjectIcon | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` resets the project to its automatic (derived) icon. */
  readonly onSave: (icon: ProjectIcon | null) => void;
}) {
  const automatic = deriveProjectIdentity(title);
  const [mode, setMode] = useState<ProjectIcon["kind"]>(current?.kind ?? "lucide");
  const [iconName, setIconName] = useState<IconName>(
    current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON,
  );
  const [color, setColor] = useState<ProjectIconColor>(current && "color" in current ? current.color : automatic.color);
  const [letters, setLetters] = useState(current?.kind === "monogram" ? current.text : automatic.monogram);
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const [image, setImage] = useState(current?.kind === "image" ? current.dataUrl : null);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bumped per pick and per open, so a slow conversion can't land over a newer pick or a reopen.
  const imageRequestRef = useRef(0);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setMode(current?.kind ?? "lucide");
      setIconName(current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON);
      setColor(current && "color" in current ? current.color : automatic.color);
      setLetters(current?.kind === "monogram" ? current.text : automatic.monogram);
      setEmoji(current?.kind === "emoji" ? current.emoji : "💻");
      setQuery("");
      setCustomEmoji("");
      setImage(current?.kind === "image" ? current.dataUrl : null);
      setImageError(null);
      imageRequestRef.current += 1;
    }
    previousOpenRef.current = open;
  }, [current, open, automatic.color, automatic.monogram]);

  const candidates = useIconCandidates(projectId, open && mode === "image");
  const icons = useMemo(() => filterProjectIconNames(query), [query]);
  const selectedColorClassName = projectIconColorClassName(color);
  const monogram = letters.normalize("NFKC").trim().toUpperCase();
  const validMonogram = isMonogramText(monogram, color);
  const canSave = mode === "monogram" ? validMonogram : mode === "image" ? image !== null : true;
  const save = () => {
    if (!canSave) return;
    onSave(
      mode === "monogram"
        ? { kind: "monogram", text: monogram, color }
        : mode === "lucide"
          ? { kind: "lucide", name: iconName, color }
          : mode === "image" && image
            ? { kind: "image", dataUrl: image }
            : { kind: "emoji", emoji },
    );
    onOpenChange(false);
  };

  const takeImageFile = async (file: Blob | undefined) => {
    const request = ++imageRequestRef.current;
    if (!file) {
      setImageError("Choose an image file.");
      return;
    }
    setImageError(null);
    try {
      const dataUrl = await imageFileToIconDataUrl(file);
      if (request === imageRequestRef.current) setImage(dataUrl);
    } catch (error) {
      if (request !== imageRequestRef.current) return;
      setImageError(error instanceof IconImageError ? error.message : "That image couldn't be used.");
    }
  };
  const takeCandidate = async (path: string) => {
    if (!projectId) return;
    // Fetched like a dropped file would be read, so the same resize and size checks apply.
    const response = await fetch(iconCandidateSrc(projectId, path)).catch(() => null);
    if (!response?.ok) {
      imageRequestRef.current += 1;
      setImageError("That image couldn't be read. It may have been moved or deleted.");
      return;
    }
    await takeImageFile(await response.blob());
  };
  const imageFrom = (items: DataTransferItemList) =>
    [...items]
      .find((item) => item.kind === "file" && (item.type === "" || item.type.startsWith("image/")))
      ?.getAsFile() ?? undefined;
  const onPaste = (event: ClipboardEvent) => {
    if (mode !== "image") return;
    const file = imageFrom(event.clipboardData.items);
    if (!file) return;
    event.preventDefault();
    void takeImageFile(file);
  };
  // Handled on the whole popup so a drop that misses the zone doesn't navigate away to the file.
  const onDragOver = (event: DragEvent) => {
    if (mode === "image") event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    if (mode !== "image") return;
    event.preventDefault();
    void takeImageFile(imageFrom(event.dataTransfer.items));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]" onPaste={onPaste} onDragOver={onDragOver} onDrop={onDrop}>
        <DialogHeader>
          <DialogTitle>Choose project icon</DialogTitle>
          <DialogDescription>Choose an icon, emoji, monogram, or image.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col">
          <ToggleGroup
            aria-label="Icon type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "lucide" || value === "emoji" || value === "monogram" || value === "image") setMode(value);
            }}
          >
            <Toggle value="lucide">Icons</Toggle>
            <Toggle value="emoji">Emoji</Toggle>
            <Toggle value="monogram">Monogram</Toggle>
            <Toggle value="image">Image</Toggle>
          </ToggleGroup>

          {mode === "lucide" || mode === "monogram" ? (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Icon color">
                {PROJECT_ICON_COLORS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={color === option.value}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      color === option.value && "border-foreground/64",
                    )}
                    onClick={() => setColor(option.value)}
                  >
                    <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {mode === "lucide" ? (
            <>
              <Input
                type="search"
                value={query}
                aria-label="Search Lucide icons"
                placeholder="Search all Lucide icons"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {icons.map((name) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={iconLabel(name)}
                      aria-pressed={iconName === name}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        iconName === name && "border-border bg-accent",
                        selectedColorClassName,
                      )}
                      onClick={() => setIconName(name)}
                    >
                      <DynamicIcon name={name} className="size-5" />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {icons.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No icons found.</p>
              ) : null}
            </>
          ) : mode === "monogram" ? (
            <div className="flex items-center gap-4 py-2">
              <ProjectMonogram text={validMonogram ? monogram : automatic.monogram} color={color} className="size-12" />
              <div className="flex-1 space-y-2">
                <label htmlFor="project-monogram" className="text-sm font-medium">
                  Letters
                </label>
                <Input
                  id="project-monogram"
                  value={letters}
                  onChange={(event) => setLetters(event.currentTarget.value)}
                  aria-describedby="project-monogram-hint"
                  aria-invalid={!validMonogram}
                  autoComplete="off"
                />
                <p id="project-monogram-hint" className="text-xs text-muted-foreground">
                  One or two letters or numbers.
                </p>
              </div>
            </div>
          ) : mode === "image" ? (
            <>
              {projectId && candidates.data && candidates.data.length > 0 ? (
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">Found in project</div>
                  <ScrollArea scrollFade className="max-h-40">
                    <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                      {candidates.data.map((candidate) => (
                        <button
                          key={candidate.path}
                          type="button"
                          title={candidate.path}
                          aria-label={candidate.path}
                          className="flex aspect-square items-center justify-center rounded-md border border-transparent p-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          onClick={() => void takeCandidate(candidate.path)}
                        >
                          <img
                            src={iconCandidateSrc(projectId, candidate.path)}
                            alt=""
                            loading="lazy"
                            className="size-full object-contain"
                          />
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              <div className="flex items-center gap-4 rounded-lg border border-dashed border-border p-4">
                {image ? (
                  <img src={image} alt="Selected icon" className="size-12 shrink-0 rounded-[25%] object-contain" />
                ) : (
                  <div className="size-12 shrink-0 rounded-[25%] bg-muted" />
                )}
                <div className="flex-1 space-y-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) void takeImageFile(file);
                      event.currentTarget.value = "";
                    }}
                  />
                  <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                    {image ? "Choose another image" : "Choose image"}
                  </Button>
                  {imageError ? (
                    <p className="text-xs text-destructive-foreground">{imageError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Or drop or paste one here. It's resized to a small square.
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {PROJECT_EMOJIS.map((option) => (
                    <button
                      key={option.emoji}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={emoji === option.emoji}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        emoji === option.emoji && "border-border bg-accent",
                      )}
                      onClick={() => setEmoji(option.emoji)}
                    >
                      {option.emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">Or paste any emoji</div>
                <Input
                  value={customEmoji}
                  aria-label="Custom emoji"
                  placeholder="Paste an emoji"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCustomEmoji(value);
                    const nextEmoji = firstEmoji(value);
                    if (nextEmoji) setEmoji(nextEmoji);
                  }}
                />
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {current ? (
            <Button
              variant="ghost"
              onClick={() => {
                onSave(null);
                onOpenChange(false);
              }}
            >
              Use automatic icon
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
