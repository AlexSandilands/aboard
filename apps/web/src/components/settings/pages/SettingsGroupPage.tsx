import type { AppSettings } from "@repo/contracts";
import { useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AutopilotEngineSection } from "~/components/autopilot/AutopilotSettingsSection";
import { CustomAutomationsSection } from "~/components/autopilot/CustomAutomationsSection";
import { BoardVariablesSection } from "~/components/autopilot/VariablesSection";
import { NotificationsSection } from "~/components/notifications/NotificationsSection";
import { VersionAndSocial } from "~/components/social/SocialSettings";
import { useIntegrationsStatus, useSettings } from "~/state/queries";
import { AppearanceSection } from "../AppearanceSection";
import { ArchivedProjectsSection } from "../ArchivedProjectsSection";
import { BackupSection } from "../BackupSection";
import {
  ClaudeCodeSection,
  CodexSection,
  CopilotSection,
  GithubSection,
  JiraSection,
  T3Section,
} from "../IntegrationsSections";
import { IssueImportSection } from "../IssueImportSection";
import { KeybindingsSection } from "../KeybindingsSection";
import { ModelTiersSection } from "../ModelTiersSection";
import { PlanSkillSection } from "../PlanSkillSection";
import { ReviewSettingsSection } from "../ReviewSettingsSection";
import { SettingsScroller, SettingsTopBar } from "../SettingsShell";
import { SettingsSubsection } from "../settingsLayout";
import { SuggestionsSection } from "../SuggestionsSection";
import { isSettingsGroup, type SettingsGroupId } from "../settingsNav.logic";
import { TemplatesSection } from "../TemplatesSection";
import { TerminalSection } from "../TerminalSection";
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
          <SettingsSubsection id="board.data">
            <WithSettings>{(settings) => <BackupSection settings={settings} />}</WithSettings>
            <ArchivedProjectsSection />
          </SettingsSubsection>
          <WithSettings>{(settings) => <VersionAndSocial settings={settings} />}</WithSettings>
        </>
      );
    case "keybindings":
      return <WithSettings>{(settings) => <KeybindingsSection settings={settings} />}</WithSettings>;
    case "tasks":
      return <TasksContent />;
    case "models":
      return <ModelsContent />;
    case "autopilot":
      return (
        <>
          <SettingsSubsection id="autopilot.engine">
            <AutopilotEngineSection />
          </SettingsSubsection>
          <SettingsSubsection id="autopilot.custom">
            <CustomAutomationsSection />
            <BoardVariablesSection />
          </SettingsSubsection>
        </>
      );
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

function ModelsContent() {
  const integrations = useIntegrationsStatus();
  return (
    <SettingsSubsection id="models.tiers">
      <WithSettings>{(settings) => <ModelTiersSection settings={settings} t3={integrations.data?.t3} />}</WithSettings>
    </SettingsSubsection>
  );
}

function IntegrationsContent() {
  const integrations = useIntegrationsStatus();
  return (
    <>
      <SettingsSubsection id="integrations.t3-code">
        <WithSettings>{(settings) => <T3Section settings={settings} status={integrations.data?.t3} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.claude-code">
        <WithSettings>{(settings) => <ClaudeCodeSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.copilot">
        <WithSettings>{(settings) => <CopilotSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.codex">
        <WithSettings>{(settings) => <CodexSection settings={settings} />}</WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.github">
        <WithSettings>
          {(settings) => <GithubSection settings={settings} status={integrations.data?.github} />}
        </WithSettings>
      </SettingsSubsection>
      <SettingsSubsection id="integrations.jira">
        <WithSettings>{(settings) => <JiraSection settings={settings} />}</WithSettings>
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
