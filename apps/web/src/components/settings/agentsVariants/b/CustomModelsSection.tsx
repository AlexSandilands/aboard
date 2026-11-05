import { MODEL_PROFILES_MAX, type AppSettings, type ModelProfile } from "@repo/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { PickerIcon } from "~/components/models/PickerIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { BlurInput } from "../../BlurInput";
import {
  createProfileEdits,
  labelConflicts,
  parseLabelList,
  profileIdFor,
  saveProfileEdit,
  type ProfileEdit,
} from "../../modelProfiles.logic";
import type { TierProvider } from "../../modelTiers.logic";
import { SETTINGS_TEXT_WIDTH, SettingsGroup, SettingsNote, SettingsRow, SettingsSection } from "../../settingsLayout";
import { activeProviders, modelSummary, preferredChoices, providerLabel } from "./b.logic";
import { ModelField, PreferredSelect } from "./fields";

type ProfileChange = Extract<ProfileEdit, { kind: "change" }>["change"];

/**
 * Custom models: named models beyond the tiers, one compact row each (name, labels, what each provider runs), edited
 * in a dialog so the list stays a list however many providers there are. Task labels pick a custom model whatever the
 * task's tier, and a model picker anywhere can pick one too.
 */
export function CustomModelsSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createProfileEdits()).current;
  const [editing, setEditing] = useState<string | null>(null);
  const profiles = settings.modelProfiles;
  const shown = activeProviders(settings.providers);
  const save = (edit: ProfileEdit) => void saveProfileEdit(edits, updateSettings.mutateAsync, profiles, edit);
  const add = () => {
    // The id the add gives the model, so its dialog opens as soon as the saved list comes back.
    const id = profileIdFor("New model", new Set(profiles.map((p) => p.id)));
    save({ kind: "add", name: "New model" });
    setEditing(id);
  };
  const open = profiles.find((p) => p.id === editing) ?? null;
  return (
    <SettingsSection
      id="agents.models.custom.list"
      title="Custom models"
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
          None yet. A custom model runs the tasks that carry one of its labels, whatever their tier.
        </SettingsNote>
      ) : (
        profiles.map((profile, index) => {
          const summary = modelSummary(profile, shown);
          return (
            <SettingsRow
              key={profile.id}
              id={`agents.models.custom.${profile.id}`}
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate">{profile.name}</span>
                  {profile.labels.map((label) => (
                    <Badge key={label} size="sm" variant="secondary">
                      {label}
                    </Badge>
                  ))}
                </span>
              }
              description={profile.description?.trim() || undefined}
              status={summary ? <span className="block">{summary}</span> : undefined}
              control={
                <div className="flex items-center gap-0.5">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${profile.name} up`}
                    disabled={index === 0}
                    onClick={() => save({ kind: "move", id: profile.id, delta: -1 })}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${profile.name} down`}
                    disabled={index === profiles.length - 1}
                    onClick={() => save({ kind: "move", id: profile.id, delta: 1 })}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button size="xs" variant="outline" className="ms-1.5" onClick={() => setEditing(profile.id)}>
                    Edit
                  </Button>
                </div>
              }
            />
          );
        })
      )}
      {labelConflicts(profiles).map(({ label, winner, shadowed }) => (
        <SettingsNote key={label}>
          Label {label} is on {[winner, ...shadowed].join(" and ")}: {winner} wins, being first in the list.
        </SettingsNote>
      ))}
      <Dialog open={open !== null} onOpenChange={(next) => !next && setEditing(null)}>
        <DialogPopup className="max-w-2xl">
          {open ? (
            <EditModelDialog
              profile={open}
              settings={settings}
              shown={shown}
              onChange={(change) => save({ kind: "change", id: open.id, change })}
              onRemove={() => {
                save({ kind: "remove", id: open.id });
                setEditing(null);
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

/** One custom model's fields: its name, labels and description, the provider it prefers, and a model per provider. */
function EditModelDialog({
  profile,
  settings,
  shown,
  onChange,
  onRemove,
}: {
  profile: ModelProfile;
  settings: AppSettings;
  shown: readonly TierProvider[];
  onChange: (change: ProfileChange) => void;
  onRemove: () => void;
}) {
  const choices = preferredChoices(settings.providers, profile.provider);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{profile.name}</DialogTitle>
        <DialogDescription>
          Tasks with one of its labels run on it whatever their tier; an operation or automation can pick it too.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <SettingsGroup>
          <SettingsRow
            title="Name"
            control={
              <BlurInput
                size="sm"
                className={cn("w-full", SETTINGS_TEXT_WIDTH)}
                aria-label="Model name"
                value={profile.name}
                onSave={(next) => onChange({ field: "name", value: next })}
              />
            }
          />
          <SettingsRow
            title="Labels"
            description="Task labels that pick this model, separated by commas."
            control={
              <BlurInput
                size="sm"
                className={cn("w-full", SETTINGS_TEXT_WIDTH)}
                aria-label={`${profile.name} labels`}
                placeholder="codex61, fast-lane"
                value={profile.labels.join(", ")}
                onSave={(next) => onChange({ field: "labels", value: parseLabelList(next) })}
              />
            }
          />
          <SettingsRow
            title="Description"
            description="How prompts copied from a task name it."
            control={
              <BlurInput
                size="sm"
                className={cn("w-full", SETTINGS_TEXT_WIDTH)}
                aria-label={`${profile.name} description`}
                placeholder={profile.t3?.label ?? "e.g. Codex, high"}
                value={profile.description ?? ""}
                onSave={(next) => onChange({ field: "description", value: next.trim() || null })}
              />
            }
          />
          {choices.length > 0 ? (
            <SettingsRow
              title="Preferred provider"
              description="Headless runs try it first when it can do what the run needs."
              control={
                <PreferredSelect
                  choices={choices}
                  value={profile.provider}
                  name={profile.name}
                  onChange={(harness) => onChange({ field: "headless", value: harness })}
                />
              }
            />
          ) : null}
        </SettingsGroup>
        <SettingsGroup>
          {shown.length === 0 ? (
            <SettingsNote>Switch a provider on under Providers to set what it runs for this model.</SettingsNote>
          ) : (
            shown.map((provider) => (
              <SettingsRow
                key={provider}
                title={
                  <span className="flex items-center gap-2">
                    <PickerIcon
                      icon={provider === "t3" ? { kind: "t3code" } : { kind: "harness", harness: provider }}
                      className="size-4"
                    />
                    {providerLabel(provider)}
                  </span>
                }
                control={<ModelField provider={provider} name={profile.name} setting={profile} onChange={onChange} />}
              />
            ))
          )}
        </SettingsGroup>
      </DialogPanel>
      <DialogFooter className="sm:justify-between">
        <Button size="sm" variant="ghost-destructive" onClick={onRemove}>
          Remove model
        </Button>
        <DialogClose render={<Button size="sm" />}>Done</DialogClose>
      </DialogFooter>
    </>
  );
}
