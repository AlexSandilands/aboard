// Design D's Providers: the baseline's list-and-editor (ProvidersPage.tsx, itself from T3 Code's
// ProviderSettingsPanel, MIT — see NOTICE) on the shared split card, and one calm empty state before any is added.
import { PROVIDERS, type AppSettings, type ProviderId, type ProviderStatus } from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BotIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { useRecheckProviders, useUpdateProviders } from "~/state/mutations";
import { useIntegrationsStatus, useProviders } from "~/state/queries";
import { ProviderEditor } from "../../ProviderEditors";
import { ProviderIcon } from "../../ProvidersPage";
import {
  addableProviders,
  detectionLabel,
  patchProvider,
  providerDot,
  providerLosses,
  providerSubtitle,
  selectedProvider,
  withoutProvider,
  withProvider,
} from "../../providers.logic";
import { SettingsGroup, SettingsSectionHeader, SettingsSubsection, StatusDot } from "../../settingsLayout";
import { DetailBody, DetailHeader, SplitCard, SplitList, SplitListAction, SplitListItem } from "./SplitCard";

export function ProvidersSection({ settings }: { settings: AppSettings }) {
  const providers = useProviders();
  const recheck = useRecheckProviders();
  const t3 = useIntegrationsStatus().data?.t3;
  const updateProviders = useUpdateProviders();
  const navigate = useNavigate();
  const requested = useSearch({ strict: false, select: (search) => search.provider });
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<{ id: ProviderId; action: "disable" | "remove" } | null>(null);

  const added = settings.providers;
  const selected = selectedProvider(added, requested);
  const statusOf = (id: ProviderId) => providers.data?.providers.find((p) => p.id === id);
  const select = (id: ProviderId) =>
    void navigate({ to: "/settings/$group", params: { group: "agents" }, search: { provider: id }, replace: true });
  // Each change is applied to the latest list when it runs (useUpdateProviders), not to the one this render saw.
  const save = (change: (current: AppSettings["providers"]) => AppSettings["providers"]) =>
    updateProviders.mutate(change);

  const add = (id: ProviderId) => {
    save((current) => withProvider(current, id));
    setAdding(false);
    select(id);
  };
  const setEnabled = (id: ProviderId, enabled: boolean) => {
    // Switching off says what stops working first; switching on needs no confirm.
    if (enabled) save((current) => patchProvider(current, id, { enabled }));
    else setConfirm({ id, action: "disable" });
  };
  const confirmed = () => {
    if (!confirm) return;
    const { id, action } = confirm;
    if (action === "disable") save((current) => patchProvider(current, id, { enabled: false }));
    else save((current) => withoutProvider(current, id));
    setConfirm(null);
  };

  const selectedSetting = added.find((p) => p.id === selected);
  const checked = providers.data ? new Date(providers.data.checkedAt) : null;

  return (
    <SettingsSubsection id="agents.providers">
      <section className="space-y-2.5">
        <SettingsSectionHeader
          title="Providers"
          headerAction={
            added.length > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="-me-2"
                disabled={recheck.isPending}
                aria-busy={recheck.isPending}
                onClick={() => recheck.mutate()}
                title="Check every provider again"
              >
                <RefreshCwIcon className={cn(recheck.isPending && "animate-spin")} />
                <span className="hidden sm:inline">
                  {recheck.isPending
                    ? "Checking…"
                    : checked
                      ? `Checked ${checked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                      : "Re-check"}
                </span>
              </Button>
            ) : null
          }
        />
        {added.length === 0 ? (
          <NoProviders onAdd={() => setAdding(true)} />
        ) : (
          <SplitCard
            list={
              <SplitList label="Added providers">
                {added.map((setting) => {
                  const status = statusOf(setting.id);
                  const dot = providerDot(setting.id, status, setting, providers.isError);
                  return (
                    <SplitListItem
                      key={setting.id}
                      icon={<ProviderIcon id={setting.id} className={cn(!setting.enabled && "opacity-50")} />}
                      title={PROVIDERS[setting.id].label}
                      badge={<StatusDot tone={dot.tone} label={dot.label} />}
                      subtitle={setting.enabled ? providerSubtitle(setting.id, status) : "Off"}
                      selected={setting.id === selected}
                      onSelect={() => select(setting.id)}
                      trailing={
                        <Switch
                          size="sm"
                          aria-label={`${PROVIDERS[setting.id].label} on`}
                          checked={setting.enabled}
                          onCheckedChange={(on) => setEnabled(setting.id, on)}
                        />
                      }
                    />
                  );
                })}
                {addableProviders(added).length > 0 ? (
                  <SplitListAction
                    icon={<PlusIcon className="size-4 shrink-0" />}
                    label="Add provider"
                    onClick={() => setAdding(true)}
                  />
                ) : null}
              </SplitList>
            }
          >
            {selected === null ? null : !selectedSetting ? (
              <NotAdded id={selected} status={statusOf(selected)} onAdd={() => add(selected)} />
            ) : (
              <DetailBody>
                <ProviderHeader
                  id={selected}
                  enabled={selectedSetting.enabled}
                  status={statusOf(selected)}
                  failed={providers.isError}
                  onEnable={() => setEnabled(selected, !selectedSetting.enabled)}
                  onRemove={() => setConfirm({ id: selected, action: "remove" })}
                />
                {selectedSetting.enabled ? (
                  <ProviderEditor
                    id={selected}
                    settings={settings}
                    status={statusOf(selected)}
                    t3={t3}
                    recheck={() => recheck.mutate()}
                    rechecking={recheck.isPending}
                  />
                ) : (
                  <p className="px-3 text-sm text-muted-foreground sm:px-4">
                    {PROVIDERS[selected].label} is switched off: the board offers it nowhere. Its settings are kept for
                    when you switch it back on.
                  </p>
                )}
              </DetailBody>
            )}
          </SplitCard>
        )}
      </section>
      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        addable={addableProviders(added)}
        statusOf={statusOf}
        onAdd={add}
      />
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogPopup showCloseButton={false} className="max-w-md">
          {confirm ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {confirm.action === "disable" ? "Switch off" : "Remove"} {PROVIDERS[confirm.id].label}?
                </DialogTitle>
                <DialogDescription>
                  {confirm.action === "disable"
                    ? "Its settings are kept for when you switch it back on."
                    : "Its CLI path is forgotten; add it again any time."}{" "}
                  Sessions and threads already linked to tasks still open.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <ul className="list-disc space-y-1 ps-4 text-sm text-muted-foreground">
                  {providerLosses(confirm.id).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button variant="destructive" onClick={confirmed}>
                  {confirm.action === "disable" ? "Switch off" : "Remove"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </SettingsSubsection>
  );
}

/**
 * The whole of Settings → Agents before a provider is added: one card, one button, which lists every provider to pick
 * from. It never offers just the one a link or an earlier selection names (`?provider=t3`).
 */
function NoProviders({ onAdd }: { onAdd: () => void }) {
  return (
    <SettingsGroup>
      <Empty size="compact" className="min-h-0 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>No providers yet</EmptyTitle>
          <EmptyDescription>
            Add the coding agents on this machine to start sessions from tasks, run reviews and Autopilot, and pick
            their models.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={onAdd}>
            <PlusIcon />
            Add provider
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsGroup>
  );
}

/** The selected provider's name, state and actions, above its editor sections. */
function ProviderHeader({
  id,
  enabled,
  status,
  failed,
  onEnable,
  onRemove,
}: {
  id: ProviderId;
  enabled: boolean;
  status: ProviderStatus | undefined;
  failed: boolean;
  onEnable: () => void;
  onRemove: () => void;
}) {
  const dot = providerDot(id, status, { enabled }, failed);
  return (
    <DetailHeader
      icon={<ProviderIcon id={id} className="size-6" />}
      title={PROVIDERS[id].label}
      subtitle={
        <span className="flex items-center gap-1.5">
          <StatusDot tone={dot.tone} label={dot.label} />
          <span className="truncate">{dot.label}</span>
        </span>
      }
      actions={
        <>
          <Button size="xs" variant="ghost-muted" onClick={onEnable}>
            {enabled ? "Switch off" : "Switch on"}
          </Button>
          <Button size="xs" variant="ghost-destructive" onClick={onRemove}>
            Remove
          </Button>
        </>
      }
    />
  );
}

/** A provider named in the URL (a search result, an old link) that isn't added: what it is, and a way to add it. */
function NotAdded({ id, status, onAdd }: { id: ProviderId; status: ProviderStatus | undefined; onAdd: () => void }) {
  const detection = detectionLabel(id, status);
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <div className="flex items-center gap-3">
        <ProviderIcon id={id} className="size-6" />
        <h2 className="text-base font-medium text-foreground">{PROVIDERS[id].label}</h2>
      </div>
      <p className="max-w-md text-sm text-muted-foreground">{PROVIDERS[id].blurb}</p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot tone={detection.tone} label={detection.label} />
        {detection.label}
      </p>
      <Button size="sm" onClick={onAdd}>
        <PlusIcon />
        Add {PROVIDERS[id].label}
      </Button>
    </div>
  );
}

/** The providers not added yet, each with what this machine has; picking one adds it and selects it. */
function AddProviderDialog({
  open,
  onOpenChange,
  addable,
  statusOf,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addable: ProviderId[];
  statusOf: (id: ProviderId) => ProviderStatus | undefined;
  onAdd: (id: ProviderId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>Only the providers you add show up on the board.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-2 sm:grid-cols-2">
            {addable.map((id) => {
              const detection = detectionLabel(id, statusOf(id));
              return (
                <button
                  key={id}
                  type="button"
                  className="flex cursor-pointer flex-col items-start gap-2 rounded-lg border border-border/60 p-3 text-left transition-colors outline-none hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onAdd(id)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <ProviderIcon id={id} />
                    {PROVIDERS[id].label}
                  </span>
                  <span className="text-xs text-muted-foreground">{PROVIDERS[id].blurb}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone={detection.tone} label={detection.label} />
                    {detection.label}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
