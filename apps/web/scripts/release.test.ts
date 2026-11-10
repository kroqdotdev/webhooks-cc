import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bumpFromLabels,
  bumpVersion,
  checkPullRequest,
  FRAGMENT_DIR,
  highestBump,
  plan,
  validateFragment,
} from "./release.mjs";

describe("version arithmetic", () => {
  it("bumps the way semver does", () => {
    expect(bumpVersion("0.63.1", "patch")).toBe("0.63.2");
    expect(bumpVersion("0.63.1", "minor")).toBe("0.64.0");
    expect(bumpVersion("0.63.1", "major")).toBe("1.0.0");
    expect(bumpVersion("0.63.1", "none")).toBe("0.63.1");
  });

  it("takes the highest bump of a release", () => {
    expect(highestBump(["patch", "none", "minor", "patch"])).toBe("minor");
    expect(highestBump(["none"])).toBe("none");
    expect(highestBump([])).toBe("none");
  });

  it("reads one release label and ignores the rest", () => {
    expect(bumpFromLabels(["dependencies", "release: minor"])).toBe("minor");
    expect(bumpFromLabels(["dependencies"])).toBeNull();
    expect(() => bumpFromLabels(["release: patch", "release: minor"])).toThrow(/more than one/);
  });
});

describe("validateFragment", () => {
  it("accepts a title and items", () => {
    expect(validateFragment("a-fix.json", '{"title":"A fix","items":["It works"]}')).toEqual([]);
  });

  it("names every problem", () => {
    const dash = String.fromCharCode(0x2014);
    expect(validateFragment("Bad Name.json", "{")).toEqual([
      expect.stringMatching(/lowercase letters/),
      expect.stringMatching(/not valid JSON/),
    ]);
    expect(validateFragment("x.json", '{"title":"","items":[],"date":"x"}')).toEqual([
      expect.stringMatching(/unknown keys date/),
      expect.stringMatching(/"title"/),
      expect.stringMatching(/"items"/),
    ]);
    expect(validateFragment("x.json", `{"title":"A ${dash} B","items":["c"]}`)).toEqual([
      expect.stringMatching(/em dashes/),
    ]);
  });
});

/** A throwaway repository with the history a deploy would see. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "release-test-"));
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).replace(/\n$/, "");
  run(["init", "-q", "-b", "main"]);
  const prs = new Map<string, { number: number; labels: string[] }>();
  let number = 0;

  return {
    dir,
    git: (args: string[]) => run(args),
    /** One squash-merged pull request: files to add, the labels it had. */
    merge(labels: string[] | null, files: Record<string, string> = {}, remove: string[] = []) {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), text);
      }
      for (const file of remove) unlinkSync(path.join(dir, file));
      writeFileSync(path.join(dir, "code.txt"), `change ${++number}\n`);
      run(["add", "-A"]);
      run(["commit", "-q", "-m", `change ${number}`]);
      const sha = run(["rev-parse", "HEAD"]);
      if (labels) prs.set(sha, { number, labels });
      return sha;
    },
    tag(name: string, date: string) {
      run(["tag", "-a", name, "-m", name], { GIT_COMMITTER_DATE: `${date}T12:00:00Z` });
    },
    pullRequestFor: async (sha: string) => prs.get(sha) ?? null,
  };
}

const fragment = (title: string, ...items: string[]) => JSON.stringify({ title, items });
const at = (name: string) => `${FRAGMENT_DIR}/${name}.json`;

describe("plan", () => {
  let repo: ReturnType<typeof makeRepo>;
  const today = "2026-11-12";

  beforeEach(() => {
    repo = makeRepo();
    repo.merge(null);
    repo.tag("web-v0.64.0", "2026-11-10");
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const deploy = (ref: string, environment = "production", warn?: (m: string) => void) =>
    plan({
      git: repo.git,
      ref,
      environment,
      today,
      pullRequestFor: repo.pullRequestFor,
      warn,
    });

  it("applies the highest bump since the last release and gathers its changelog files", async () => {
    repo.merge(["release: patch"], { [at("a-fix")]: fragment("A fix", "Fixed a thing") });
    repo.merge(["release: minor"], { [at("big")]: fragment("Big", "New a", "New b") });
    const head = repo.merge(["release: none"]);

    const result = await deploy(head);
    expect(result).toMatchObject({
      sha: head,
      version: "0.65.0",
      tag: "web-v0.65.0",
      previous: "web-v0.64.0",
      bump: "minor",
    });
    expect(result.pullRequests.map((p: { bump: string }) => p.bump)).toEqual([
      "patch",
      "minor",
      "none",
    ]);
    expect(result.entries).toEqual([
      {
        version: "0.65.0",
        date: today,
        title: "A fix; Big",
        track: "web",
        items: ["Fixed a thing", "New a", "New b"],
      },
    ]);
  });

  it("dates earlier releases by their tag and files each change under the release that shipped it", async () => {
    repo.merge(["release: patch"], { [at("one")]: fragment("One", "1") });
    repo.tag("web-v0.64.1", "2026-11-11");
    repo.merge(["release: patch"], { [at("two")]: fragment("Two", "2") });

    const result = await deploy("HEAD");
    expect(result.version).toBe("0.64.2");
    expect(
      result.entries.map((e: { version: string; date: string; title: string }) => [
        e.version,
        e.date,
        e.title,
      ])
    ).toEqual([
      ["0.64.2", today, "Two"],
      ["0.64.1", "2026-11-11", "One"],
    ]);
  });

  it("shows a changelog file as it reads now, and drops a deleted one", async () => {
    repo.merge(["release: patch"], {
      [at("one")]: fragment("One", "typo"),
      [at("gone")]: fragment("Gone", "x"),
    });
    repo.tag("web-v0.64.1", "2026-11-11");
    repo.merge(["release: none"], { [at("one")]: fragment("One", "fixed") }, [at("gone")]);

    const result = await deploy("HEAD");
    expect(result).toMatchObject({ version: "0.64.1", tag: null, bump: "none" });
    expect(result.entries).toEqual([
      { version: "0.64.1", date: "2026-11-11", title: "One", track: "web", items: ["fixed"] },
    ]);
  });

  it("deploys a tagged commit as its own version again, so a rollback keeps its number", async () => {
    const one = repo.merge(["release: patch"], { [at("one")]: fragment("One", "1") });
    repo.tag("web-v0.64.1", "2026-11-11");
    repo.merge(["release: minor"], { [at("two")]: fragment("Two", "2") });
    repo.tag("web-v0.65.0", "2026-11-12");

    const result = await deploy("web-v0.64.1");
    expect(result).toMatchObject({ sha: one, version: "0.64.1", tag: null });
    expect(result.entries.map((e: { version: string }) => e.version)).toEqual(["0.64.1"]);
  });

  it("refuses an untagged commit behind the newest release, whose number is taken", async () => {
    const older = repo.merge(["release: patch"], { [at("one")]: fragment("One", "1") });
    repo.merge(["release: patch"], { [at("two")]: fragment("Two", "2") });
    repo.tag("web-v0.64.1", "2026-11-11");

    await expect(deploy(older)).rejects.toThrow(/is behind web-v0.64.1/);
  });

  it("keeps the version when nothing since the last release ships", async () => {
    repo.merge(["release: none"]);
    const result = await deploy("HEAD");
    expect(result).toMatchObject({ version: "0.64.0", tag: null, bump: "none" });
  });

  it("marks a dry run and never tags it", async () => {
    repo.merge(["release: minor"], { [at("one")]: fragment("One", "1") });
    const result = await deploy("HEAD", "dryrun");
    expect(result).toMatchObject({ version: "0.65.0-dryrun", tag: null });
    expect(result.entries[0].version).toBe("0.65.0");
  });

  it("counts an unlabelled change as a patch when it adds a changelog file", async () => {
    const warnings: string[] = [];
    repo.merge(null, { [at("one")]: fragment("One", "1") });
    repo.merge(null);
    const result = await deploy("HEAD", "production", (m) => warnings.push(m));
    expect(result.version).toBe("0.64.1");
    expect(warnings).toEqual([
      expect.stringMatching(/no release label; counted as patch/),
      expect.stringMatching(/no release label; counted as none/),
    ]);
  });

  it("needs a release tag to start from", async () => {
    repo.git(["tag", "-d", "web-v0.64.0"]);
    await expect(deploy("HEAD")).rejects.toThrow(/tag the last release first/);
  });

  it("refuses an invalid changelog file rather than deploying without it", async () => {
    repo.merge(["release: patch"], { [at("bad")]: '{"title":"x"}' });
    await expect(deploy("HEAD")).rejects.toThrow(/"items"/);
  });
});

describe("checkPullRequest", () => {
  let repo: ReturnType<typeof makeRepo>;
  let base: string;

  beforeEach(() => {
    repo = makeRepo();
    base = repo.merge(null);
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const check = (labels: string[]) =>
    checkPullRequest({ git: repo.git, base, head: "HEAD", labels });

  it("passes a labelled change with its changelog file", () => {
    repo.merge(null, { [at("one")]: fragment("One", "1") });
    expect(check(["release: patch"])).toEqual([]);
  });

  it("passes release: none without a changelog file, and lets it edit a released one", () => {
    repo.merge(null, { [at("old")]: fragment("Old", "1") });
    base = repo.git(["rev-parse", "HEAD"]);
    repo.merge(null, { [at("old")]: fragment("Old", "fixed") });
    expect(check(["release: none"])).toEqual([]);
  });

  it("asks for exactly one release label", () => {
    repo.merge(null);
    expect(check([])).toEqual([expect.stringMatching(/Add one release label/)]);
    expect(check(["release: none", "release: patch"])).toEqual([
      expect.stringMatching(/not several/),
    ]);
  });

  it("asks a release for its changelog file and refuses one on release: none", () => {
    repo.merge(null);
    expect(check(["release: minor"])).toEqual([expect.stringMatching(/needs a changelog file/)]);
    repo.merge(null, { [at("one")]: fragment("One", "1") });
    expect(check(["release: none"])).toEqual([expect.stringMatching(/ships no changelog entry/)]);
  });

  it("validates the changelog files the change touches", () => {
    repo.merge(null, { [at("one")]: '{"title":"One"}' });
    expect(check(["release: patch"])).toEqual([expect.stringMatching(/"items"/)]);
  });
});
