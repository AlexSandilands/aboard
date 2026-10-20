import { TICKET_SYSTEM_PRESETS, type AppSettings, type TicketSystem } from "@repo/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useUpdateSettings } from "~/state/mutations";
import { BlurInput } from "./BlurInput";
import { parseToolList } from "./issueImport.logic";
import { SettingsNote, SettingsRow, SettingsSection, StatusDot } from "./settingsLayout";
import { addTicketSystem, removeTicketSystem, ticketSystemsDot, updateTicketSystem } from "./ticketSystems.logic";

/**
 * The issue trackers the board links and imports tickets from (docs/features/ticket-systems.md). Each field saves on
 * blur; one the server would refuse (a pattern that doesn't compile, say) isn't sent, and a toast says why.
 */
export function TicketSystemsSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const systems = settings.ticketSystems;
  const dot = ticketSystemsDot(systems);

  const save = (next: TicketSystem[]) =>
    updateSettings.mutate(
      { ticketSystems: next },
      {
        onError: (error) =>
          toastManager.add({ type: "error", title: "Couldn't save the ticket systems", description: error.message }),
      },
    );
  const patch = (id: string, change: Partial<Omit<TicketSystem, "id">>) => {
    const result = updateTicketSystem(systems, id, change);
    if ("error" in result) {
      toastManager.add({ type: "error", title: "Not saved", description: result.error });
      return;
    }
    save(result.systems);
  };

  return (
    <SettingsSection
      id="integrations.tickets.status"
      title="Ticket systems"
      status={<StatusDot tone={dot.tone} label={dot.label} />}
      headerAction={
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" />}>
            <PlusIcon />
            Add
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => save(addTicketSystem(systems, null))}>Blank system</MenuItem>
            <MenuSeparator />
            {TICKET_SYSTEM_PRESETS.map((preset) => (
              <MenuItem key={preset.label} onClick={() => save(addTicketSystem(systems, preset))}>
                <span className="flex flex-col">
                  <span>From the {preset.label} preset</span>
                  <span className="text-xs text-muted-foreground">{preset.description}</span>
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      }
    >
      {systems.length === 0 ? (
        <SettingsNote>
          None yet. Add one so ticket keys and URLs become links, and tickets can be imported as tasks.
        </SettingsNote>
      ) : (
        systems.map((system) => (
          <TicketSystemRows
            key={system.id}
            system={system}
            onPatch={(change) => patch(system.id, change)}
            onRemove={() => save(removeTicketSystem(systems, system.id))}
          />
        ))
      )}
    </SettingsSection>
  );
}

function TicketSystemRows({
  system,
  onPatch,
  onRemove,
}: {
  system: TicketSystem;
  onPatch: (change: Partial<Omit<TicketSystem, "id">>) => void;
  onRemove: () => void;
}) {
  // Keyed by the stored value, so a field shows what was saved once the settings come back.
  const text = (
    field: "name" | "keyPattern" | "urlPattern" | "linkTemplate",
    label: string,
    placeholder: string,
    mono = true,
  ) => (
    <BlurInput
      key={system[field] ?? ""}
      aria-label={`${system.name} ${label}`}
      size="sm"
      className={mono ? "font-mono sm:w-72" : "sm:w-72"}
      placeholder={placeholder}
      value={system[field] ?? ""}
      onSave={(next) => onPatch({ [field]: next.trim() })}
    />
  );
  return (
    <>
      <SettingsRow
        id={`integrations.tickets.system-${system.id}`}
        title={system.name}
        description={`Stored on its links as "${system.id}".`}
        control={
          <>
            {text("name", "name", "Name", false)}
            <Button size="xs" variant="ghost" aria-label={`Remove ${system.name}`} onClick={onRemove}>
              <Trash2Icon />
            </Button>
          </>
        }
      />
      <SettingsRow
        title="Key pattern"
        description="A regular expression for a whole key. Keys it matches in pasted values become links."
        control={text("keyPattern", "key pattern", String.raw`[A-Z][A-Z0-9]+-\d+`)}
      />
      <SettingsRow
        title="URL pattern"
        description="A regular expression for a ticket's URL, with the key in its first group."
        control={text("urlPattern", "URL pattern", String.raw`^https://example\.com/browse/([A-Z]+-\d+)`)}
      />
      <SettingsRow
        title="Link template"
        description="The page of a key, with {key} where it goes."
        control={text("linkTemplate", "link template", "https://example.com/browse/{key}")}
      />
      <SettingsRow
        title="Link keys in titles"
        description="A key in a task's title is linked by itself. Off, agents are only told about it."
        control={
          <Switch
            aria-label={`${system.name}: link keys in titles`}
            checked={system.autoLink}
            onCheckedChange={(checked) => onPatch({ autoLink: checked })}
          />
        }
      />
      <SettingsRow
        title="Import tools"
        description="The MCP tools an import may call to read a ticket, comma-separated."
        info="Tickets are read through your own MCP server in Claude Code, with only these tools allowed, for example mcp__atlassian__getJiraIssue, plus a search tool to import an epic's tasks. Tools that look like writes are denied."
        control={
          <BlurInput
            key={system.importTools.join(",")}
            aria-label={`${system.name} import tools`}
            size="sm"
            className="font-mono sm:w-72"
            placeholder="mcp__<server>__<tool>, …"
            value={system.importTools.join(", ")}
            onSave={(next) => onPatch({ importTools: parseToolList(next) })}
          />
        }
      />
      <SettingsRow
        title="Import instructions"
        description="What an import is told about reading this system's tickets and finding an epic's children."
      >
        <InstructionsField
          key={system.importInstructions}
          label={`${system.name} import instructions`}
          value={system.importInstructions}
          onSave={(next) => onPatch({ importInstructions: next })}
        />
      </SettingsRow>
    </>
  );
}

function InstructionsField({ label, value, onSave }: { label: string; value: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <Textarea
      aria-label={label}
      size="sm"
      className="mt-2"
      rows={4}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onSave(draft);
      }}
    />
  );
}
