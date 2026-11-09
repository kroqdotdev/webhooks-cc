"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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
 * Which settings sections hold edits that are not saved yet. Every section's
 * SaveFooter reports its own dirty state here (by the section it sits in), so
 * the dashboard can ask before leaving them and the panel can point at them.
 */

export interface DirtySection {
  id: string;
  title: string;
}

interface DirtySectionsValue {
  dirty: DirtySection[];
  report: (section: DirtySection, dirty: boolean) => void;
}

const DirtySectionsContext = createContext<DirtySectionsValue | null>(null);

/** The section a SaveFooter sits in, set by Section. */
export const SectionIdentityContext = createContext<DirtySection | null>(null);

/** Sorts sections by where they are on the page, so the first is the topmost. */
function inPageOrder(list: DirtySection[]): DirtySection[] {
  if (typeof document === "undefined") return list;
  const position = (id: string) => {
    const el = document.getElementById(`settings-${id}`);
    if (!el) return Number.MAX_SAFE_INTEGER;
    const all = Array.from(document.querySelectorAll("[data-settings-section]"));
    return all.indexOf(el);
  };
  return [...list].sort((a, b) => position(a.id) - position(b.id));
}

export function DirtySectionsProvider({
  onChange,
  children,
}: {
  /** Told about every change, in page order. */
  onChange?: (dirty: DirtySection[]) => void;
  children: React.ReactNode;
}) {
  const [dirty, setDirty] = useState<DirtySection[]>([]);

  const report = useCallback((section: DirtySection, isDirty: boolean) => {
    setDirty((prev) => {
      const has = prev.some((entry) => entry.id === section.id);
      if (isDirty === has) return prev;
      return isDirty
        ? inPageOrder([...prev, section])
        : prev.filter((entry) => entry.id !== section.id);
    });
  }, []);

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

  const value = useMemo(() => ({ dirty, report }), [dirty, report]);
  return <DirtySectionsContext.Provider value={value}>{children}</DirtySectionsContext.Provider>;
}

/** The unsaved sections, in page order; empty outside a provider. */
export function useDirtySections(): DirtySection[] {
  return useContext(DirtySectionsContext)?.dirty ?? EMPTY;
}

const EMPTY: DirtySection[] = [];

/** Reports whether the section this sits in has unsaved edits. */
export function useReportDirty(dirty: boolean) {
  const context = useContext(DirtySectionsContext);
  const section = useContext(SectionIdentityContext);
  const report = context?.report;
  const id = section?.id;
  const title = section?.title;
  useEffect(() => {
    if (!report || !id || !title) return;
    report({ id, title }, dirty);
    return () => report({ id, title }, false);
  }, [report, id, title, dirty]);
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
  return (
    // Each way out says what it means: Escape and Keep editing keep, Discard discards.
    <AlertDialog open={open}>
      <AlertDialogContent
        className="border-strong border-line shadow-raised"
        onEscapeKeyDown={onKeep}
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
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onKeep}>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDiscard}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
