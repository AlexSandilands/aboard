import { AUTOMATION_EXAMPLES, AUTOMATION_RECIPES } from "@repo/contracts";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CustomAutomationEditorForm } from "~/components/autopilot/CustomAutomationEditorForm";
import { CustomAutomationImportForm } from "~/components/autopilot/CustomAutomationImportForm";
import { AutopilotTabPage } from "~/components/autopilot/AutopilotPage";
import { emptyCustomForm, formFromCustom } from "~/components/autopilot/customAutomations.logic";
import { RunHistory } from "~/components/autopilot/RunHistory";
import { emptyRuleForm, formFromRule } from "~/components/recurring/recurring.logic";
import { RuleEditorForm } from "~/components/recurring/RuleEditorForm";
import { TemplateEditorForm } from "~/components/templates/TemplateEditorForm";
import { emptyForm, formFromTemplate } from "~/components/templates/templates.logic";
import { useCustomAutomations } from "~/state/customAutomations";
import { useBoard, useTemplates } from "~/state/queries";
import { useRecurringRules } from "~/state/recurring";
import { EditorPage } from "../EditorFrame";
import { SettingsLink } from "../settingsLayout";
import { editorListSection, type SettingsGroupId } from "../settingsNav.logic";
import { FROM_SETTINGS_LIST, useLeaveEditor } from "../settingsNavigation";
import { SettingsScroller, SettingsTopBar } from "../SettingsShell";

/** Where the rule editor returns to: the Recurring tasks automation, showing the project's rules. */
const RECURRING_LIST = editorListSection("project");

/** "new" in an editor's URL stands for one not saved yet. */
const NEW = "new";

/** An editor sub-page: the top bar's crumbs end with what is being edited, and the form in the page. */
function EditorShell({ group, label, children }: { group: SettingsGroupId; label: string; children: ReactNode }) {
  return (
    <>
      <SettingsTopBar group={group} editor={label} />
      <SettingsScroller>
        <EditorPage>{children}</EditorPage>
      </SettingsScroller>
    </>
  );
}

/** Shown in place of a form while its data loads, or when what it would edit is gone. */
function EditorMessage({ children, back }: { children: ReactNode; back?: { to: string; label: string } }) {
  return (
    <p className="px-3 text-sm text-muted-foreground sm:px-4">
      {children}
      {back ? (
        <>
          {" "}
          <SettingsLink to={back.to}>{back.label}</SettingsLink>
        </>
      ) : null}
    </p>
  );
}

/** Route component for `/settings/tasks/templates/$templateId`. */
export function TemplateEditorPage() {
  const { templateId } = useParams({ from: "/_app/settings/tasks/templates/$templateId" });
  const templates = useTemplates();
  const leaveEditor = useLeaveEditor();
  const back = () => leaveEditor("tasks");
  const isNew = templateId === NEW;
  const template = isNew ? null : templates.data?.find((t) => t.id === templateId);
  return (
    <EditorShell group="tasks" label={isNew ? "New template" : `Template: ${template?.name ?? "…"}`}>
      {isNew || template ? (
        <TemplateEditorForm
          key={templateId}
          templateId={template?.id ?? null}
          initial={template ? formFromTemplate(template) : emptyForm()}
          onCancel={back}
          onDone={back}
        />
      ) : templates.data || templates.error ? (
        <EditorMessage back={{ to: "tasks.new-tasks", label: "Back to templates" }}>
          {templates.error ? templates.error.message : "This template no longer exists."}
        </EditorMessage>
      ) : (
        <EditorMessage>Loading template...</EditorMessage>
      )}
    </EditorShell>
  );
}

/** Route component for `/settings/autopilot/custom/$customId`. */
export function CustomAutomationEditorPage() {
  const { customId } = useParams({ from: "/_app/settings/autopilot/custom/$customId" });
  const customs = useCustomAutomations();
  const leaveEditor = useLeaveEditor();
  const back = () => leaveEditor("autopilot");
  const isNew = customId === NEW;
  const custom = isNew ? null : customs.data?.find((c) => c.id === customId);
  return (
    <EditorShell group="autopilot" label={isNew ? "New automation" : `Automation: ${custom?.name ?? "…"}`}>
      {isNew || custom ? (
        <CustomAutomationEditorForm
          key={customId}
          customId={custom?.id ?? null}
          initial={custom ? formFromCustom(custom) : emptyCustomForm()}
          onCancel={back}
          onDone={back}
        />
      ) : customs.data || customs.error ? (
        <EditorMessage back={{ to: "autopilot.automations", label: "Back to automations" }}>
          {customs.error ? customs.error.message : "This automation no longer exists."}
        </EditorMessage>
      ) : (
        <EditorMessage>Loading automation...</EditorMessage>
      )}
    </EditorShell>
  );
}

/** Route component for `/settings/autopilot/runs/$automation`: the Runs tab, filtered by the search params. */
export function AutopilotRunsPage() {
  const { automation } = useParams({ from: "/_app/settings/autopilot/runs/$automation" });
  const search = useSearch({ from: "/_app/settings/autopilot/runs/$automation" });
  const navigate = useNavigate();
  return (
    <AutopilotTabPage tab="runs">
      <RunHistory
        key={automation}
        automation={automation}
        search={search}
        onSearch={(next) =>
          void navigate({
            to: "/settings/autopilot/runs/$automation",
            params: { automation },
            search: next,
            replace: true,
            // Keeps the "opened from the list" mark, so Back still steps out of the history page in one go.
            state: (prev) => prev,
          })
        }
        onAutomation={(next) =>
          void navigate({
            to: "/settings/autopilot/runs/$automation",
            params: { automation: next },
            search: { ...search },
            replace: true,
            state: (prev) => prev,
          })
        }
      />
    </AutopilotTabPage>
  );
}

/** Route component for `/settings/autopilot/custom/import`, `?draft=` for an agent's draft. */
export function CustomAutomationImportPage() {
  const leaveEditor = useLeaveEditor();
  const navigate = useNavigate();
  const draftId = useSearch({ from: "/_app/settings/autopilot/custom/import", select: (search) => search.draft });
  const recipeId = useSearch({ from: "/_app/settings/autopilot/custom/import", select: (search) => search.recipe });
  const recipe = AUTOMATION_RECIPES.find((r) => r.id === recipeId);
  return (
    <EditorShell
      group="autopilot"
      label={draftId ? "Review a draft" : recipe ? `Recipe: ${recipe.title}` : "Import automation"}
    >
      <CustomAutomationImportForm
        examples={AUTOMATION_EXAMPLES}
        initial={recipe?.bundle}
        draftId={draftId}
        onCancel={() => leaveEditor("autopilot")}
        // Straight to the new automation: it comes in off, with its tools still to check.
        onDone={(customId) =>
          void navigate({
            to: "/settings/autopilot/custom/$customId",
            params: { customId },
            search: {},
            replace: true,
            state: FROM_SETTINGS_LIST,
          })
        }
      />
    </EditorShell>
  );
}

/** Route component for `/settings/project/recurring/$ruleId?project=`. */
export function RuleEditorPage() {
  const { ruleId } = useParams({ from: "/_app/settings/project/recurring/$ruleId" });
  const projectId = useSearch({ from: "/_app/settings/project/recurring/$ruleId", select: (search) => search.project });
  const board = useBoard();
  const project = board.data?.projects.find((p) => p.id === projectId);
  if (!projectId || !project) {
    // Archived projects aren't in the snapshot either, so this also covers a project archived since.
    const message = !projectId
      ? "No project was given for this rule."
      : board.data
        ? "This project no longer exists, or is archived."
        : board.error
          ? board.error.message
          : "Loading project...";
    return (
      <EditorShell group="autopilot" label="Recurring task">
        <EditorMessage back={{ to: RECURRING_LIST, label: "Back to recurring tasks" }}>{message}</EditorMessage>
      </EditorShell>
    );
  }
  return <RuleEditor key={`${projectId}/${ruleId}`} projectId={projectId} ruleId={ruleId} />;
}

function RuleEditor({ projectId, ruleId }: { projectId: string; ruleId: string }) {
  const rules = useRecurringRules(projectId);
  const leaveEditor = useLeaveEditor();
  const back = () => leaveEditor("project");
  const isNew = ruleId === NEW;
  const rule = isNew ? null : rules.data?.find((r) => r.id === ruleId);
  return (
    <EditorShell group="autopilot" label={isNew ? "New recurring task" : `Recurring task: ${rule?.name ?? "…"}`}>
      {isNew || rule ? (
        <RuleEditorForm
          projectId={projectId}
          ruleId={rule?.id ?? null}
          initial={rule ? formFromRule(rule) : emptyRuleForm()}
          onCancel={back}
          onDone={back}
        />
      ) : rules.data || rules.error ? (
        <EditorMessage back={{ to: RECURRING_LIST, label: "Back to recurring tasks" }}>
          {rules.error ? rules.error.message : "This rule no longer exists."}
        </EditorMessage>
      ) : (
        <EditorMessage>Loading rule...</EditorMessage>
      )}
    </EditorShell>
  );
}
