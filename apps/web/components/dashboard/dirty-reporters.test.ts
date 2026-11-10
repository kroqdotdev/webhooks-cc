import { describe, expect, it, vi } from "vitest";
import {
  dirtySectionsOf,
  leavesEditedSettings,
  reportDirty,
  type DirtyReporter,
} from "./dirty-reporters";

const reporter = (
  reporterId: string,
  sectionId: string,
  save?: () => Promise<boolean>
): DirtyReporter => ({ reporterId, sectionId, title: `Title of ${sectionId}`, save });

describe("reportDirty", () => {
  it("adds a form once and returns the same list when nothing changed", () => {
    const first = reporter("a", "forwarding");
    const list = reportDirty([], first, true);
    expect(list).toEqual([first]);
    expect(reportDirty(list, first, true)).toBe(list);
    expect(reportDirty(list, reporter("b", "forwarding"), false)).toBe(list);
  });

  it("keeps a section unsaved while another of its forms still is", () => {
    const a = reporter("a", "forwarding");
    const b = reporter("b", "forwarding");
    let list = reportDirty(reportDirty([], a, true), b, true);
    list = reportDirty(list, b, false);
    expect(list).toEqual([a]);
    expect(dirtySectionsOf(list).map((section) => section.id)).toEqual(["forwarding"]);
    expect(reportDirty(list, a, false)).toEqual([]);
  });

  it("takes a form's new save in place", () => {
    const save = async () => true;
    const list = reportDirty(
      [reporter("a", "alerts"), reporter("b", "alerts")],
      reporter("a", "alerts", save),
      true
    );
    expect(list.map((entry) => entry.reporterId)).toEqual(["a", "b"]);
    expect(list[0].save).toBe(save);
  });
});

describe("dirtySectionsOf", () => {
  it("lists each section once, in the order its first form reported", () => {
    const sections = dirtySectionsOf([
      reporter("a", "forwarding"),
      reporter("b", "alerts"),
      reporter("c", "forwarding"),
    ]);
    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ["forwarding", "Title of forwarding"],
      ["alerts", "Title of alerts"],
    ]);
  });

  it("saves every form of a section and succeeds only when all did", async () => {
    const ok = vi.fn(async () => true);
    const fails = vi.fn(async () => false);
    const alsoOk = vi.fn(async () => true);
    const [failing] = dirtySectionsOf([
      reporter("a", "forwarding", ok),
      reporter("b", "forwarding", fails),
      reporter("c", "forwarding", alsoOk),
    ]);
    await expect(failing.save?.()).resolves.toBe(false);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(fails).toHaveBeenCalledTimes(1);
    expect(alsoOk).toHaveBeenCalledTimes(1);

    const [passing] = dirtySectionsOf([
      reporter("a", "forwarding", ok),
      reporter("c", "forwarding", alsoOk),
    ]);
    await expect(passing.save?.()).resolves.toBe(true);
  });

  it("offers no save when one of the forms has none", () => {
    const [section] = dirtySectionsOf([
      reporter("a", "forwarding", async () => true),
      reporter("b", "forwarding"),
    ]);
    expect(section.save).toBeUndefined();
  });
});

describe("leavesEditedSettings", () => {
  const place = { editing: "acme", slug: "acme", settings: true, defaultSlug: "first" };

  it("stays while the URL keeps Settings on the edited endpoint", () => {
    expect(leavesEditedSettings(place)).toBe(false);
    // No ?endpoint= opens the default endpoint, which may be the edited one.
    expect(leavesEditedSettings({ ...place, slug: null, defaultSlug: "acme" })).toBe(false);
  });

  it("leaves when Settings is gone from the URL", () => {
    expect(leavesEditedSettings({ ...place, settings: false })).toBe(true);
  });

  it("leaves for another endpoint, known to the list or not", () => {
    expect(leavesEditedSettings({ ...place, slug: "just-created" })).toBe(true);
    expect(leavesEditedSettings({ ...place, slug: null })).toBe(true);
    expect(leavesEditedSettings({ ...place, slug: null, defaultSlug: undefined })).toBe(true);
  });
});
