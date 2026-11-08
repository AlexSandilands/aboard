import type { AppSettings } from "@repo/contracts";
import { useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AutopilotAutomationsTab } from "~/components/autopilot/AutopilotPage";
import { DesktopAppSection } from "~/components/desktop/DesktopAppSection";
import { NotificationsSection } from "~/components/notifications/NotificationsSection";
import { VersionAndSocial } from "~/components/social/SocialSettings";
import { desktopBridge } from "~/lib/desktopBridge";
import { useIntegrationsStatus, useSettings } from "~/state/queries";
import { AgentsPage } from "../agents/AgentsPage";
import { AppearanceSection } from "../AppearanceSection";
import { ArchivedProjectsSection } from "../ArchivedProjectsSection";
import { RecentlyDeletedSection } from "../RecentlyDeletedSection";
import { BackupSection } from "../BackupSection";
import { GitHostsSection } from "../IntegrationsSections";
import { IssueImportSection } from "../IssueImportSection";
import { KeybindingsSection } from "../KeybindingsSection";
import { PlanSkillSection } from "../PlanSkillSection";
import { ReviewSettingsSection } from "../ReviewSettingsSection";
import { SettingsScroller, SettingsTopBar } from "../SettingsShell";
import { SettingsSubsection } from "../settingsLayout";
import { SuggestionsSection } from "../SuggestionsSection";
import { isSettingsGroup, type SettingsGroupId } from "../settingsNav.logic";
import { TemplatesSection } from "../TemplatesSection";
import { TerminalSection } from "../TerminalSection";
import { TicketSystemsSection } from "../TicketSystemsSection";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

/** Route component for `/settings/$group`: the group's sections in one scrolling page. */
export function SettingsGroupPage() {
  const { group } = useParams({ from: "/_app/settings/$group" });
  // The route redirects anything else; this only narrows the type.
  if (!isSettingsGroup(group)) return null;
  // Keyed so each page starts at its top, with its own scroll-spy.
  return <GroupPage key={group} group={group} />;
}

function GroupPage({ group }: { group: SettingsGroupId }) {
  if (group === "project") return <ProjectSettingsPage />;
  return (
    <>
      <SettingsTopBar group={group} />
      <SettingsScroller>
        <GroupContent group={group} />
      </SettingsScroller>
    </>
  );
}

function GroupContent({ group }: { group: Exclude<SettingsGroupId, "project"> }) {
  switch (group) {
    case "board":
      return (
        <>
          <SettingsSubsection id="board.appearance">
            <AppearanceSection />
          </SettingsSubsection>
          <SettingsSubsection id="board.notifications">
            <WithSettings>{(settings) => <NotificationsSection settings={settings} />}</WithSettings>
          </SettingsSubsection>
          {desktopBridge() ? (
            <SettingsSubsection id="board.desktop">
              <DesktopAppSection />
            </SettingsSubsection>
          ) : null}
          <SettingsSubsection id="board.data">
            <WithSettings>{(settings) => <BackupSection settings={settings} />}</WithSettings>
            <ArchivedProjectsSection />
            <WithSettings>{(settings) => <RecentlyDeletedSection settings={settings} />}</WithSettings>
          </SettingsSubsection>
          <WithSettings>{(settings) => <VersionAndSocial settings={settings} />}</WithSettings>
        </>
      );
    case "keybindings":
      return <WithSettings>{(settings) => <KeybindingsSection settings={settings} />}</WithSettings>;
    case "tasks":
      return <TasksContent />;
    case "agents":
      return <AgentsContent />;
    case "autopilot":
      return <AutopilotAutomationsTab />;
    case "integrations":
      return <IntegrationsContent />;
  }
}

function TasksContent() {
  return (
    <>
      <SettingsSubsection id="tasks.new-tasks">
        <TemplatesSection />
        <WithSettings>{(settings) => <IssueImportSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="tasks.planning">
        <WithSettings>{(settings) => <PlanSkillSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="tasks.review">
        <WithSettings>{(settings) => <ReviewSettingsSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="tasks.suggestions">
        <SuggestionsSection />
      </SettingsSubsection>
    </>
  );
}

function AgentsContent() {
  return <WithSettings>{(settings) => <AgentsPage settings={settings} />}</WithSettings>;
}

function IntegrationsContent() {
  const integrations = useIntegrationsStatus();
  return (
    <>
      <SettingsSubsection id="integrations.github">
        <WithSettings>
          {(settings) => <GitHostsSection settings={settings} statuses={integrations.data?.gitHosts} />}
        </WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.tickets">
        <WithSettings>{(settings) => <TicketSystemsSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.terminal">
        <WithSettings>{(settings) => <TerminalSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
    </>
  );
}

/** Renders once the app settings have loaded; until then a line saying so (or why they didn't). */
function WithSettings({ children }: { children: (settings: AppSettings) => ReactNode }) {
  const settings = useSettings();
  if (settings.data) return children(settings.data);
  return (
    <p className="px-3 text-sm text-muted-foreground sm:px-4">
      {settings.error ? settings.error.message : "Loading settings..."}
    </p>
  );
}
