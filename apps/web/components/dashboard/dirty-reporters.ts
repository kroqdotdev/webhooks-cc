/**
 * The bookkeeping behind unsaved settings (dirty-sections.tsx). A section can
 * hold several forms that save on their own (the Destinations section has one
 * editor per destination), so every form reports under its own id and the
 * section is unsaved while any of its forms is.
 */

/** One form with unsaved edits. */
export interface DirtyReporter {
  /** The form's own id, unique on the page (useId). */
  reporterId: string;
  /** The section the form sits in. */
  sectionId: string;
  /** The section's title. */
  title: string;
  /**
   * Runs the form's own save, as its Save button would, and resolves true once
   * it saved, false when it did not.
   */
  save?: () => Promise<boolean>;
}

/** A section with unsaved edits in one or more of its forms. */
export interface DirtySection {
  id: string;
  title: string;
  /**
   * Saves every unsaved form in the section, one after the other, and resolves
   * true only when all of them saved. Missing when one of them cannot be saved
   * from outside.
   */
  save?: () => Promise<boolean>;
}

/**
 * The list after one form said whether it has unsaved edits. Returns the list
 * it was given when nothing changed, so a repeated report costs no render.
 */
export function reportDirty(
  list: DirtyReporter[],
  reporter: DirtyReporter,
  dirty: boolean
): DirtyReporter[] {
  const index = list.findIndex((entry) => entry.reporterId === reporter.reporterId);
  if (!dirty) return index === -1 ? list : list.filter((_, i) => i !== index);
  if (index === -1) return [...list, reporter];
  const current = list[index];
  if (
    current.sectionId === reporter.sectionId &&
    current.title === reporter.title &&
    current.save === reporter.save
  ) {
    return list;
  }
  return list.map((entry, i) => (i === index ? reporter : entry));
}

/** The unsaved sections, each once, in the order their first form reported. */
export function dirtySectionsOf(list: DirtyReporter[]): DirtySection[] {
  const groups = new Map<string, DirtyReporter[]>();
  for (const reporter of list) {
    const group = groups.get(reporter.sectionId);
    if (group) group.push(reporter);
    else groups.set(reporter.sectionId, [reporter]);
  }
  return Array.from(groups, ([id, reporters]) => {
    const saves = reporters.map((reporter) => reporter.save);
    const section: DirtySection = { id, title: reporters[0].title };
    if (saves.every((save) => save !== undefined)) {
      section.save = async () => {
        let ok = true;
        // Every form gets its turn, so one that fails does not hold back the rest.
        for (const save of saves) {
          if (!(await save!())) ok = false;
        }
        return ok;
      };
    }
    return section;
  });
}

/**
 * Whether a change of the dashboard's URL takes the person away from the
 * settings they are editing: Settings is no longer the view, or the URL names
 * another endpoint. Compared by slug, never by looking the endpoint up, so a
 * link to an endpoint the list has not loaded yet (one just created) still
 * counts as another endpoint.
 */
export function leavesEditedSettings(place: {
  /** The endpoint whose settings hold the edits. */
  editing: string;
  /** ?endpoint= now. */
  slug: string | null;
  /** Whether ?view=settings is still there. */
  settings: boolean;
  /** The endpoint a URL without ?endpoint= opens. */
  defaultSlug: string | undefined;
}): boolean {
  if (!place.settings) return true;
  return (place.slug ?? place.defaultSlug) !== place.editing;
}
