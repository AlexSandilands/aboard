import { LABELS_PER_TASK_MAX, type TaskDetail } from "@repo/contracts";
import { PlusIcon, RotateCcwIcon, ShuffleIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { PanelControl } from "~/components/task/PanelControl";
import { TaskSection } from "~/components/task/TaskSection";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { useSetLabelColor, useSetTaskLabels } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { LabelChip, useLabelColors } from "./LabelChip";
import { SUGGESTED_HUES, labelCounts, labelHue, labelStyle, shuffleHue, suggestLabels } from "./labels.logic";

const HUE_GRADIENT = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => `oklch(0.62 0.16 ${i * 30})`).join(", ")})`;

/** The task's labels: add from those in use or create one, remove, and pick each label's colour. */
export function LabelsSection({ task }: { task: TaskDetail }) {
  const { mutate: setLabels } = useSetTaskLabels(task.id);
  const colors = useLabelColors();
  // The list the user asked for while edits are in flight. Detail refetches between edits can still carry an
  // older list, so the next edit builds on this one rather than on what the server last said.
  const [pending, setPending] = useState<string[] | null>(null);
  const inFlight = useRef(0);
  const labels = pending ?? task.labels;

  const save = (next: string[]) => {
    setPending([...next].sort());
    inFlight.current += 1;
    setLabels(next, {
      onSettled: () => {
        inFlight.current -= 1;
        if (inFlight.current === 0) setPending(null);
      },
    });
  };

  return (
    <TaskSection title="Labels">
      <div className="flex flex-wrap items-center gap-1 px-1.5">
        {labels.map((label) => (
          <LabelChip
            key={label}
            label={label}
            colors={colors}
            size="default"
            onRemove={() => save(labels.filter((l) => l !== label))}
          >
            <ColorPopover label={label} colors={colors} />
          </LabelChip>
        ))}
        {labels.length < LABELS_PER_TASK_MAX ? (
          <AddLabelPopover current={labels} onAdd={(label) => save([...labels, label])} />
        ) : null}
      </div>
    </TaskSection>
  );
}

function AddLabelPopover({ current, onAdd }: { current: ReadonlyArray<string>; onAdd: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const tasks = useBoard().data?.tasks;
  const colors = useLabelColors();
  const inUse = useMemo(() => labelCounts(tasks ?? []).map((l) => l.name), [tasks]);
  const { existing, create } = suggestLabels(query, inUse, current);
  const options = create ? [...existing, create] : existing;
  const active = Math.min(highlight, options.length - 1);

  const add = (label: string) => {
    onAdd(label);
    setQuery("");
    setHighlight(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + options.length) % Math.max(options.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const label = options[active];
      if (label) add(label);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger render={<PanelControl part="meta" />}>
        <PlusIcon className="size-3.5" />
        {current.length ? "Add" : "Add label"}
      </PopoverTrigger>
      <PopoverPopup align="start" width="sm" padding="compact">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            aria-label="Label"
            size="sm"
            value={query}
            placeholder="ui, backend, bug…"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
          {options.length ? (
            <div role="listbox" aria-label="Labels" className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
              {options.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    "flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-xs text-muted-foreground outline-none",
                    index === active && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => add(label)}
                >
                  {label === create && !existing.includes(label) ? <span>Create</span> : null}
                  <LabelChip label={label} colors={colors} />
                </button>
              ))}
            </div>
          ) : (
            <p className="px-1.5 text-xs text-muted-foreground">
              {inUse.length ? "Type to create a label." : "No labels yet. Type one to create it."}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** A dot inside the chip that opens the colour picker for that label (board-wide). */
function ColorPopover({ label, colors }: { label: string; colors: Readonly<Record<string, number>> }) {
  const { mutate: setColor } = useSetLabelColor();
  const saved = labelHue(label, colors);
  const overridden = colors[label] !== undefined;
  const [draft, setDraft] = useState<number | null>(null);
  const hue = draft ?? saved;

  const commit = (next: number) => {
    setDraft(null);
    if (next !== saved) setColor({ label, hue: next });
  };

  return (
    <Popover onOpenChange={(open) => !open && draft !== null && commit(draft)}>
      <PopoverTrigger
        aria-label={`Colour of ${label}`}
        title="Change colour"
        className="order-first inline-flex size-3 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-2 rounded-full bg-(--label)" />
      </PopoverTrigger>
      <PopoverPopup align="start" width="sm" padding="compact">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <LabelChip label={label} colors={colors} hue={hue} size="default" />
            <span className="ms-auto text-xs text-muted-foreground">
              {overridden || draft !== null ? `${hue}°` : "Auto"}
            </span>
          </div>
          <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Suggested colours">
            {SUGGESTED_HUES.map((h) => (
              <button
                key={h}
                type="button"
                aria-label={`Hue ${h}°`}
                aria-pressed={hue === h}
                style={labelStyle(h)}
                className={cn(
                  "h-6 cursor-pointer rounded-md bg-(--label) outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  hue === h && "ring-2 ring-foreground/70 ring-offset-1 ring-offset-popover",
                )}
                onClick={() => commit(h)}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={hue}
            aria-label="Hue"
            className="h-3 w-full cursor-pointer appearance-none rounded-full [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow"
            style={{ background: HUE_GRADIENT }}
            onChange={(event) => setDraft(Number(event.currentTarget.value))}
            onPointerUp={(event) => commit(Number(event.currentTarget.value))}
            onKeyUp={(event) => commit(Number(event.currentTarget.value))}
          />
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => commit(shuffleHue(hue))}>
              <ShuffleIcon />
              Shuffle
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="ms-auto"
              disabled={!overridden}
              onClick={() => {
                setDraft(null);
                setColor({ label, hue: null });
              }}
            >
              <RotateCcwIcon />
              Reset to auto
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
