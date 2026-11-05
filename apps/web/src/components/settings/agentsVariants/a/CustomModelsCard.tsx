import { MODEL_PROFILES_MAX, type ModelProfile } from "@repo/contracts";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { useSettingsNav } from "~/state/ui";
import { BlurInput } from "../../BlurInput";
import {
  createProfileEdits,
  labelConflicts,
  parseLabelList,
  profileIdFor,
  saveProfileEdit,
  type ProfileEdit,
} from "../../modelProfiles.logic";
import type { TierChange, TierProvider } from "../../modelTiers.logic";
import { SettingsNote } from "../../settingsLayout";
import {
  CONTROL_COLUMN,
  InfoSection,
  ProviderMark,
  ProviderModelField,
  ProviderSlot,
  providerLabel,
  type ModelContext,
} from "./parts";
import { modelsSet, showsPreferred } from "./variantA.logic";

const NEW_MODEL = "New model";

/**
 * Named models beyond the tiers, one folded row each: its name, labels and the models it has. Opening one shows its
 * fields and a row per provider, so an editor stays one column wide however many providers there are.
 */
export function CustomModelsCard({
  profiles,
  shown,
  ctx,
}: {
  profiles: readonly ModelProfile[];
  shown: readonly TierProvider[];
  ctx: ModelContext;
}) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createProfileEdits()).current;
  const save = (edit: ProfileEdit) => void saveProfileEdit(edits, updateSettings.mutateAsync, profiles, edit);
  const conflicts = labelConflicts(profiles);
  // A new model opens once the save brings it back, ready to be named.
  const [opened, setOpened] = useState<string | null>(null);
  const add = () => {
    setOpened(profileIdFor(NEW_MODEL, new Set(profiles.map((p) => p.id))));
    save({ kind: "add", name: NEW_MODEL });
  };

  return (
    <InfoSection
      id="agents.models.custom.list"
      title="Custom models"
      info="A custom model has a model on each provider, like a tier, and task labels that pick it whatever the task's tier (the first in the list wins a shared label). Any model picker can pick one too, for an operation or an automation."
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          className="-me-2"
          disabled={profiles.length >= MODEL_PROFILES_MAX}
          onClick={add}
        >
          <PlusIcon />
          Add model
        </Button>
      }
    >
      {profiles.length === 0 ? (
        <SettingsNote>
          None yet. Add one to run tasks with a label of your choosing on a model of their own.
        </SettingsNote>
      ) : (
        profiles.map((profile, index) => (
          <CustomModelRow
            key={profile.id}
            profile={profile}
            shown={shown}
            ctx={ctx}
            first={index === 0}
            last={index === profiles.length - 1}
            defaultOpen={opened === profile.id}
            save={save}
          />
        ))
      )}
      {conflicts.map(({ label, winner, shadowed }) => (
        <SettingsNote key={label}>
          Label {label} is on {[winner, ...shadowed].join(" and ")}: {winner} wins, being first in the list.
        </SettingsNote>
      ))}
    </InfoSection>
  );
}

function CustomModelRow({
  profile,
  shown,
  ctx,
  first,
  last,
  defaultOpen,
  save,
}: {
  profile: ModelProfile;
  shown: readonly TierProvider[];
  ctx: ModelContext;
  first: boolean;
  last: boolean;
  defaultOpen: boolean;
  save: (edit: ProfileEdit) => void;
}) {
  const id = `agents.models.custom.${profile.id}`;
  const [open, setOpen] = useState(defaultOpen);
  const [seenDefault, setSeenDefault] = useState(defaultOpen);
  if (defaultOpen !== seenDefault) {
    setSeenDefault(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  // A link to the model (a picker's "edit" or a search result) lands inside the fold, so open it first.
  const target = useSettingsNav((s) => s.scrollTarget);
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  if (target && target.nonce !== openedFor && target.id === id) {
    setOpenedFor(target.nonce);
    if (!open) setOpen(true);
  }
  const change = (next: Extract<ProfileEdit, { kind: "change" }>["change"]) =>
    save({ kind: "change", id: profile.id, change: next });
  const set = modelsSet(profile, shown);
  const preferred = showsPreferred(shown);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<div id={`agents.models.custom.${profile.id}`} className="scroll-mt-4" />}
    >
      <div className="flex items-center gap-2 px-3 sm:px-4">
        <CollapsibleTrigger className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
              {profile.labels.map((label) => (
                <span
                  key={label}
                  className="shrink-0 rounded-sm bg-muted px-1.5 font-mono text-[11px] leading-4 text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {set.length > 0
                ? set.map((m) => `${providerLabel(m.provider)}: ${m.model}`).join(" · ")
                : "Every provider's default model"}
            </span>
          </span>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Move ${profile.name} up`}
            disabled={first}
            onClick={() => save({ kind: "move", id: profile.id, delta: -1 })}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Move ${profile.name} down`}
            disabled={last}
            onClick={() => save({ kind: "move", id: profile.id, delta: 1 })}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={`Remove ${profile.name}`}
            onClick={() => save({ kind: "remove", id: profile.id })}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      <CollapsiblePanel>
        {/* A guide line under the chevron, labels under the name; fields in the same column as the tiers' above, so the two cards line up. */}
        <div className="pb-2">
          <div className="ms-5 border-s border-border/50 sm:ms-6">
            <EditorLine label="Name">
              <BlurInput
                size="sm"
                aria-label="Model name"
                value={profile.name}
                onSave={(next) => change({ field: "name", value: next })}
              />
            </EditorLine>
            <EditorLine label="Labels" hint="Tasks with one run on this model">
              <BlurInput
                size="sm"
                aria-label={`${profile.name} labels`}
                placeholder="e.g. codex61, fast-lane"
                value={profile.labels.join(", ")}
                onSave={(next) => change({ field: "labels", value: parseLabelList(next) })}
              />
            </EditorLine>
            <EditorLine label="Description" hint="Named in copied prompts">
              <BlurInput
                size="sm"
                aria-label={`${profile.name} description`}
                placeholder={profile.t3?.label ?? "e.g. Codex, high"}
                value={profile.description ?? ""}
                onSave={(next) => change({ field: "description", value: next.trim() || null })}
              />
            </EditorLine>
            {shown.map((provider) => (
              <EditorLine
                key={provider}
                label={
                  <span className="flex items-center gap-2">
                    <ProviderMark provider={provider} />
                    {providerLabel(provider)}
                  </span>
                }
                slot={
                  <ProviderSlot
                    provider={provider}
                    name={profile.name}
                    setting={profile}
                    preferred={preferred}
                    onChange={(next: TierChange) => change(next)}
                  />
                }
              >
                <ProviderModelField
                  provider={provider}
                  name={profile.name}
                  setting={profile}
                  ctx={ctx}
                  onChange={(next) => change(next)}
                />
              </EditorLine>
            ))}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** One line of a custom model's editor: what it is on the left, the field in the page's control column. */
function EditorLine({
  label,
  hint,
  slot,
  children,
}: {
  label: ReactNode;
  hint?: string;
  slot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container/row py-1.5 ps-4 pe-3 sm:pe-4">
      <div className="flex flex-col gap-1.5 @min-[34rem]/row:flex-row @min-[34rem]/row:items-center @min-[34rem]/row:gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-foreground">{label}</div>
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
        <div className={CONTROL_COLUMN}>
          {children}
          {slot ?? <span />}
        </div>
      </div>
    </div>
  );
}
