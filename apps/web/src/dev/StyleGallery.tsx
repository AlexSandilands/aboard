// Dev-only gallery of every ported primitive, mounted at /__gallery for visual parity checks.
import { BRAND, deriveProjectIdentity, storageKey, type ProjectIcon } from "@repo/contracts";
import {
  BellIcon,
  CheckIcon,
  FolderIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  MonitorIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { ProjectIconPickerDialog } from "~/components/project/ProjectIconPickerDialog";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "~/components/ui/combobox";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "~/components/ui/command";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "~/lib/timestampFormat";

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "ghost-muted",
  "ghost-destructive",
  "destructive",
  "destructive-outline",
  "warning-outline",
  "link",
  "glass",
] as const;
const BUTTON_SIZES = ["micro", "xs", "compact", "sm", "default", "lg", "xl"] as const;
const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "success",
  "info",
  "warning",
  "error",
  "destructive",
] as const;
const FRUITS = ["Apple", "Banana", "Cherry", "Dragonfruit", "Elderberry"];
const PROJECT_NAMES = ["storefront", "t3code", "shop tools", "acme", "a2b"];
// Sample timestamps for the duration/relative-time labels, fixed at module load.
const SAMPLE_STARTED_AT = new Date(Date.now() - 23 * 3600_000).toISOString();
const SAMPLE_UPDATED_AT = new Date(Date.now() - 5 * 60_000).toISOString();
const SAMPLE_ICONS: ReadonlyArray<{ title: string; icon: ProjectIcon }> = [
  { title: "Rocket", icon: { kind: "lucide", name: "rocket", color: "violet" } },
  { title: "Server", icon: { kind: "lucide", name: "server", color: "emerald" } },
  { title: "Fire", icon: { kind: "emoji", emoji: "🔥" } },
  { title: "Brain", icon: { kind: "emoji", emoji: "🧠" } },
  { title: "Custom", icon: { kind: "monogram", text: "QX", color: "rose" } },
  {
    title: "Image",
    icon: {
      kind: "image",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNITvv4/43HzP+4aAZ8kiCaYViYAADqPrCha/7uswAAAABJRU5ErkJggg==",
    },
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/40">
      <h2 className="border-b border-border/65 px-4 py-2 text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex flex-wrap items-start gap-3 p-4">{children}</div>
    </section>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      aria-label="Theme"
      value={[theme]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "light" || value === "dark" || value === "system") setTheme(value);
      }}
    >
      <Toggle value="light" aria-label="Light">
        <SunIcon />
      </Toggle>
      <Toggle value="dark" aria-label="Dark">
        <MoonIcon />
      </Toggle>
      <Toggle value="system" aria-label="System">
        <MonitorIcon />
      </Toggle>
    </ToggleGroup>
  );
}

const COMMAND_GROUPS = [
  {
    value: "Tasks",
    items: [
      { value: "new-task", label: "New task", shortcut: "N" },
      { value: "search-tasks", label: "Search tasks", shortcut: "/" },
    ],
  },
  {
    value: "Projects",
    items: [
      { value: "add-project", label: "Add project", shortcut: "P" },
      { value: "filter-project", label: "Filter by project", shortcut: "F" },
    ],
  },
];

function CommandSample() {
  return (
    <CommandDialog>
      <CommandDialogTrigger render={<Button variant="outline" />}>
        <SearchIcon /> Command palette
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </CommandDialogTrigger>
      <CommandDialogPopup>
        <Command items={COMMAND_GROUPS}>
          <CommandInput placeholder="Search commands" />
          <CommandPanel>
            <CommandList>
              {(group: (typeof COMMAND_GROUPS)[number]) => (
                <CommandGroup key={group.value} items={group.items}>
                  <CommandGroupLabel>{group.value}</CommandGroupLabel>
                  <CommandCollection>
                    {(item: (typeof COMMAND_GROUPS)[number]["items"][number]) => (
                      <CommandItem key={item.value} value={item.label}>
                        <span className="flex-1">{item.label}</span>
                        <CommandShortcut>{item.shortcut}</CommandShortcut>
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span>Select with Enter</span>
            <KbdGroup>
              <Kbd>Esc</Kbd>
            </KbdGroup>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function SampleSidebarLayout() {
  const [open, setOpen] = useState(true);
  const [sectionOpen, setSectionOpen] = useState(true);
  return (
    <div className="relative h-80 w-full overflow-hidden rounded-xl border border-border/60">
      <SidebarProvider
        open={open}
        onOpenChange={setOpen}
        className="h-full min-h-0 [&_[data-slot=sidebar-container]]:absolute [&_[data-slot=sidebar-container]]:h-full"
        data-app-sidebar
      >
        <Sidebar resizable={{ storageKey: storageKey("sidebar-width"), minWidth: 208 }}>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <SidebarStageBackdrop />
            <SidebarHeader className="relative z-10 h-[var(--workspace-topbar-height)] flex-row items-center justify-between">
              <span className="px-1 text-sm font-medium">{BRAND.name}</span>
              <Button size="icon-xs" variant="ghost-muted" aria-label="Add project">
                <PlusIcon />
              </Button>
            </SidebarHeader>
            <SidebarContent className="relative z-10">
              <SidebarGroup>
                <CollapsibleSectionHeader expanded={sectionOpen} onClick={() => setSectionOpen((v) => !v)}>
                  Projects
                </CollapsibleSectionHeader>
                {sectionOpen ? (
                  <SidebarMenu>
                    {PROJECT_NAMES.map((name, index) => (
                      <SidebarMenuItem key={name}>
                        <SidebarMenuButton isActive={index === 1}>
                          <ProjectFavicon title={name} icon={null} />
                          <span>{name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                ) : null}
              </SidebarGroup>
            </SidebarContent>
          </div>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-h-0">
          <div className="flex h-[var(--workspace-topbar-height)] items-center gap-2 border-b px-3">
            <SidebarTrigger variant="ghost-muted" />
            <span className="text-sm font-medium">Board</span>
          </div>
          <div className="p-4 text-sm text-muted-foreground">Main content on a grain surface.</div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

export function StyleGallery() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedIcon, setPickedIcon] = useState<ProjectIcon | null>(null);
  const [switchOn, setSwitchOn] = useState(true);
  const [segment, setSegment] = useState("board");

  return (
    <TooltipProvider>
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Style gallery</h1>
          <ThemeToggle />
        </div>

        <Section title="Button variants">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
          <Button disabled>disabled</Button>
          <Button>
            <Spinner /> loading
          </Button>
        </Section>

        <Section title="Button sizes">
          {BUTTON_SIZES.map((size) => (
            <Button key={size} size={size} variant="outline">
              {size}
            </Button>
          ))}
          <Button size="icon" variant="outline" aria-label="icon">
            <PlusIcon />
          </Button>
          <Button size="icon-sm" variant="outline" aria-label="icon-sm">
            <PlusIcon />
          </Button>
          <Button size="icon-xs" variant="outline" aria-label="icon-xs">
            <PlusIcon />
          </Button>
          <Button size="icon-micro" variant="outline" aria-label="icon-micro">
            <PlusIcon />
          </Button>
        </Section>

        <Section title="Badges">
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
          <Badge variant="success" size="sm">
            sm
          </Badge>
          <Badge variant="info" size="lg">
            lg
          </Badge>
          <span className="text-xs text-diff-addition-foreground">+12</span>
          <span className="text-xs text-diff-deletion-foreground">-4</span>
          <span className="text-2xs text-muted-foreground">
            {formatElapsedDurationLabel(SAMPLE_STARTED_AT)} · {formatRelativeTimeLabel(SAMPLE_UPDATED_AT)}
          </span>
        </Section>

        <Section title="Inputs">
          <div className="w-64">
            <Input placeholder="Input" />
          </div>
          <div className="w-64">
            <Input placeholder="Disabled" disabled />
          </div>
          <div className="w-64">
            <Textarea placeholder="Textarea" />
          </div>
          <Select items={FRUITS.map((f) => ({ label: f, value: f }))} defaultValue="Apple">
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {FRUITS.map((fruit) => (
                <SelectItem key={fruit} value={fruit}>
                  {fruit}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Combobox items={FRUITS}>
            <div className="w-56">
              <ComboboxInput placeholder="Combobox" />
            </div>
            <ComboboxPopup>
              <ComboboxEmpty>No results.</ComboboxEmpty>
              <ComboboxList>
                {(item: string) => (
                  <ComboboxItem key={item} value={item}>
                    {item}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
        </Section>

        <Section title="Menu, popover, tooltip, dialog, command">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>Menu</MenuTrigger>
            <MenuPopup>
              <MenuItem>
                <SettingsIcon /> Settings <MenuShortcut>Ctrl+,</MenuShortcut>
              </MenuItem>
              <MenuItem>
                <FolderIcon /> Open folder
              </MenuItem>
              <MenuSeparator />
              <MenuItem>Delete</MenuItem>
            </MenuPopup>
          </Menu>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
            <PopoverPopup>
              <PopoverTitle>Popover title</PopoverTitle>
              <p className="text-sm text-muted-foreground">Floating surface content.</p>
            </PopoverPopup>
          </Popover>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" />}>Tooltip</TooltipTrigger>
            <TooltipPopup>Helpful hint</TooltipPopup>
          </Tooltip>
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>Dialog</DialogTrigger>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Dialog title</DialogTitle>
                <DialogDescription>Dialog description text.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Input placeholder="Field" />
              </DialogPanel>
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button>Save</Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <CommandSample />
        </Section>

        <Section title="Switch, toggle group, kbd, separator">
          <Switch checked={switchOn} onCheckedChange={setSwitchOn} aria-label="Switch" />
          <ToggleGroup aria-label="View" value={[segment]} onValueChange={(next) => setSegment(next[0] ?? segment)}>
            <Toggle value="board">Board</Toggle>
            <Toggle value="list">List</Toggle>
            <Toggle value="graph">Graph</Toggle>
          </ToggleGroup>
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          <Separator className="w-full" />
        </Section>

        <Section title="Skeleton, spinner, scroll area">
          <div className="flex w-64 flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Spinner size="md" />
          <Spinner size="lg" tone="muted" />
          <ScrollArea scrollFade className="h-24 w-56 rounded-md border">
            <div className="flex flex-col gap-1 p-2 text-sm">
              {Array.from({ length: 20 }, (_, index) => (
                <span key={index}>Row {index + 1}</span>
              ))}
            </div>
          </ScrollArea>
        </Section>

        <Section title="Empty, alerts, toasts">
          <Empty className="w-72">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>No projects</EmptyTitle>
              <EmptyDescription>Add a project to get started.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div className="flex w-80 flex-col gap-2">
            <Alert>
              <BellIcon />
              <AlertTitle>Default</AlertTitle>
              <AlertDescription>Neutral alert.</AlertDescription>
            </Alert>
            <Alert variant="info">
              <BellIcon />
              <AlertTitle>Info</AlertTitle>
              <AlertDescription>Informational alert.</AlertDescription>
            </Alert>
            <Alert variant="success">
              <CheckIcon />
              <AlertTitle>Success</AlertTitle>
            </Alert>
            <Alert variant="warning">
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>Something needs attention.</AlertDescription>
            </Alert>
            <Alert variant="error">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>Something failed.</AlertDescription>
            </Alert>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["info", "success", "warning", "error", "loading"] as const).map((type) => (
              <Button
                key={type}
                variant="outline"
                size="sm"
                onClick={() => toastManager.add({ type, title: `A ${type} toast`, description: "Toast body text." })}
              >
                Toast: {type}
              </Button>
            ))}
          </div>
        </Section>

        <Section title="Project icons">
          {PROJECT_NAMES.map((name) => (
            <div key={name} className="flex items-center gap-2 text-sm">
              <ProjectFavicon title={name} icon={null} />
              <span>
                {name} <span className="text-muted-foreground">({deriveProjectIdentity(name).monogram})</span>
              </span>
            </div>
          ))}
          {SAMPLE_ICONS.map(({ title, icon }) => (
            <div key={title} className="flex items-center gap-2 text-sm">
              <ProjectFavicon title={title} icon={icon} />
              <span>{title}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 text-sm">
            <ProjectFavicon title="Picked" icon={pickedIcon} className="size-6" />
            <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
              Pick icon
            </Button>
          </div>
          <ProjectIconPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            title="Picked"
            value={pickedIcon}
            onSave={setPickedIcon}
          />
        </Section>

        <Section title="Sample sidebar layout (stage backdrop, resizable rail)">
          <SampleSidebarLayout />
        </Section>
      </div>
    </TooltipProvider>
  );
}
