"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  dirtySectionsOf,
  reportDirty,
  type DirtyReporter,
  type DirtySection,
} from "./dirty-reporters";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Which settings sections hold edits that are not saved yet. Every form that
 * saves on its own (a section's SaveFooter, a destination's editor) reports
 * its dirty state here under the section it sits in, so the dashboard can ask
 * before leaving them and the panel can point at them. The bookkeeping is in
 * dirty-reporters.ts.
 */

export type { DirtySection };

type Report = (reporter: DirtyReporter, dirty: boolean) => void;

// Two contexts, so a form that only reports does not render again every time
// the list changes.
const ReportDirtyContext = createContext<Report | null>(null);
const DirtySectionsContext = createContext<DirtySection[] | null>(null);

/** How the panel stands with the page around it (see useSettingsLeave). */
interface SettingsLeave {
  leaving: boolean;
  abandon: () => void;
}
const SettingsLeaveContext = createContext<SettingsLeave>({ leaving: false, abandon: () => {} });

/** The section a form sits in, set by Section. */
export const SectionIdentityContext = createContext<{ id: string; title: string } | null>(null);

/** Sorts sections by where they are on the page, so the first is the topmost. */
function inPageOrder(list: DirtySection[]): DirtySection[] {
  if (typeof document === "undefined") return list;
  const all = Array.from(document.querySelectorAll("[data-settings-section]"));
  const position = (id: string) => {
    const el = document.getElementById(`settings-${id}`);
    const index = el ? all.indexOf(el) : -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...list].sort((a, b) => position(a.id) - position(b.id));
}

export function DirtySectionsProvider({
  onChange,
  leaving = false,
  children,
}: {
  /** Told about every change, in page order. */
  onChange?: (dirty: DirtySection[]) => void;
  /** The page is already on its way elsewhere and only waits for the discard dialog. */
  leaving?: boolean;
  children: React.ReactNode;
}) {
  const [reporters, setReporters] = useState<DirtyReporter[]>([]);

  const report = useCallback<Report>((reporter, isDirty) => {
    setReporters((prev) => reportDirty(prev, reporter, isDirty));
  }, []);

  const dirty = useMemo(() => inPageOrder(dirtySectionsOf(reporters)), [reporters]);

  useEffect(() => {
    onChange?.(dirty);
  }, [dirty, onChange]);

  // Unmounting (the panel closed after a Discard) leaves nothing unsaved behind.
  useEffect(() => () => onChange?.([]), [onChange]);

  // A reload or a closed tab asks first while anything is unsaved.
  const anyDirty = dirty.length > 0;
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  // What is unsaved no longer matters (the endpoint was deleted): forget it
  // at once, so the navigation that follows is not asked about.
  const abandon = useCallback(() => {
    setReporters([]);
    onChange?.([]);
  }, [onChange]);
  const leave = useMemo(() => ({ leaving, abandon }), [leaving, abandon]);

  return (
    <ReportDirtyContext.Provider value={report}>
      <DirtySectionsContext.Provider value={dirty}>
        <SettingsLeaveContext.Provider value={leave}>{children}</SettingsLeaveContext.Provider>
      </DirtySectionsContext.Provider>
    </ReportDirtyContext.Provider>
  );
}

/**
 * `leaving`: the dashboard already moved on (another endpoint, out of
 * Settings) and holds this panel open only until the discard dialog is
 * answered, so a save must not write this endpoint back into the URL.
 * `abandon()` drops every unsaved edit from the count.
 */
export function useSettingsLeave(): SettingsLeave {
  return useContext(SettingsLeaveContext);
}

/** The unsaved sections, in page order; empty outside a provider. */
export function useDirtySections(): DirtySection[] {
  return useContext(DirtySectionsContext) ?? EMPTY;
}

const EMPTY: DirtySection[] = [];

/**
 * Reports whether the form this is called from has unsaved edits, under the
 * section it sits in, and how to save them, so the sticky bar and the discard
 * dialog can save a section without scrolling to it. Several forms in one
 * section each report on their own. `save` need not be stable: the latest one
 * is the one that runs.
 */
export function useReportDirty(dirty: boolean, save?: () => Promise<boolean>) {
  const report = useContext(ReportDirtyContext);
  const section = useContext(SectionIdentityContext);
  const reporterId = useId();
  const sectionId = section?.id;
  const title = section?.title;
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const canSave = save !== undefined;
  useEffect(() => {
    if (!report || !sectionId || !title) return;
    const reporter: DirtyReporter = {
      reporterId,
      sectionId,
      title,
      save: canSave ? () => saveRef.current?.() ?? Promise.resolve(false) : undefined,
    };
    report(reporter, dirty);
    return () => report(reporter, false);
  }, [report, reporterId, sectionId, title, dirty, canSave]);
}

/** "Responses", "Responses and Alerts", "Receiving, Responses and Alerts". */
export function listSectionTitles(sections: DirtySection[]): string {
  const titles = sections.map((section) => section.title);
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** Asks before unsaved settings are dropped. */
export function DiscardChangesDialog({
  sections,
  open,
  onKeep,
  onDiscard,
}: {
  sections: DirtySection[];
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  // One unsaved section can be saved from here; then the way out goes ahead.
  const save = sections.length === 1 ? sections[0].save : undefined;
  // The section named when a save fails: the dialog's own list empties as
  // the forms that did save stop reporting.
  const [failedTitle, setFailedTitle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // A fresh prompt starts without the last one's failure.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setFailed(false);
  }
  // Whether the question is still up when a save started from it finishes.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const saveAndLeave = async () => {
    if (!save || saving) return;
    setSaving(true);
    setFailed(false);
    setFailedTitle(sections[0]?.title ?? null);
    const ok = await save();
    setSaving(false);
    // The page may have gone ahead on its own once nothing was unsaved.
    if (!openRef.current) return;
    if (ok) onDiscard();
    else setFailed(true);
  };
  return (
    // Each way out says what it means: Escape and Keep editing keep, Discard discards.
    <AlertDialog open={open}>
      <AlertDialogContent
        className="border-strong border-line shadow-raised"
        // While a save runs the answer is already given: it leaves once saved.
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
          else onKeep();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Discard unsaved changes
            {sections.length > 0 ? ` in ${listSectionTitles(sections)}` : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {sections.length === 1 ? "This section has" : "These sections have"} edits that were not
            saved. Discarding them cannot be undone.
          </AlertDialogDescription>
          {failed && (
            <p role="alert" className="text-sm text-destructive-ink">
              The changes were not saved. Keep editing to see why
              {failedTitle ? ` in ${failedTitle}` : ""}.
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onKeep} disabled={saving}>
            Keep editing
          </AlertDialogCancel>
          {save && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void saveAndLeave()}
              disabled={saving}
              className="mt-2 sm:mt-0"
            >
              {saving ? "Saving..." : "Save and leave"}
            </Button>
          )}
          <AlertDialogAction
            onClick={onDiscard}
            disabled={saving}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
