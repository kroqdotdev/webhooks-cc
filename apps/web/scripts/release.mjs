/* eslint-env node */
/* global process, console, fetch */

/**
 * Web release versions, worked out when a release is deployed.
 *
 * A pull request never carries a version. It carries one label (`release:
 * patch`, `release: minor`, `release: major` or `release: none`) and, unless
 * it is `none`, a changelog file of its own in apps/web/changelog/web/. The
 * deploy runs `plan`: it finds the last deployed version (the newest
 * `web-v*` tag the deployed commit contains), reads the labels of the pull
 * requests merged since, applies the highest bump, and writes the version and
 * the web changelog to apps/web/lib/changelog-release.json for the build. A
 * production deploy then tags the commit, so the next deploy starts from it.
 *
 * Each changelog file belongs to the first version whose tag contains the
 * commit that added it, so the changelog is rebuilt from git on every deploy
 * and nothing is ever committed back to main.
 *
 * Usage (from anywhere inside the repository):
 *   node apps/web/scripts/release.mjs plan --ref <ref> --environment production|dryrun
 *        [--repo owner/name] [--out <file>] [--today YYYY-MM-DD]
 *   node apps/web/scripts/release.mjs check-pr --base <sha> --head <sha>
 *        (labels as a JSON array in the PR_LABELS environment variable)
 *
 * Needs full history and the tags (a checkout with fetch-depth 0). It uses
 * only Node's standard library, so it runs before any install.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TAG_PREFIX = "web-v";
export const FRAGMENT_DIR = "apps/web/changelog/web";
export const RELEASE_FILE = "apps/web/lib/changelog-release.json";
export const DEFAULT_REPO = "kroqdotdev/webhooks-cc";

/** The labels a pull request picks its bump with, exactly one per PR. */
export const RELEASE_LABELS = {
  "release: none": "none",
  "release: patch": "patch",
  "release: minor": "minor",
  "release: major": "major",
};

const BUMP_ORDER = ["none", "patch", "minor", "major"];
const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*\.json$/;
const EM_DASH = String.fromCharCode(0x2014);

/** "1.2.3" to [1, 2, 3]; anything else (pre-releases included) to null. */
export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function bumpVersion(version, bump) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`not a version: ${version}`);
  const [major, minor, patch] = parts;
  switch (bump) {
    case "none":
      return version;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`unknown bump: ${bump}`);
  }
}

export function highestBump(bumps) {
  return bumps.reduce(
    (highest, bump) => (BUMP_ORDER.indexOf(bump) > BUMP_ORDER.indexOf(highest) ? bump : highest),
    "none"
  );
}

/**
 * The bump a pull request's labels ask for: null when it has no release
 * label, an error when it has more than one.
 */
export function bumpFromLabels(labels) {
  const bumps = labels.filter((label) => label in RELEASE_LABELS).map((l) => RELEASE_LABELS[l]);
  if (bumps.length > 1) throw new Error(`more than one release label: ${bumps.join(", ")}`);
  return bumps[0] ?? null;
}

/** Problems with one changelog file, as sentences; empty when it is fine. */
export function validateFragment(name, text) {
  const problems = [];
  if (!FRAGMENT_NAME.test(path.basename(name))) {
    problems.push(`${name}: name it with lowercase letters, digits and dashes, ending in .json`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return [...problems, `${name}: not valid JSON (${error.message})`];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [...problems, `${name}: must be an object with "title" and "items"`];
  }
  const extra = Object.keys(value).filter((key) => key !== "title" && key !== "items");
  if (extra.length) problems.push(`${name}: unknown keys ${extra.join(", ")}`);
  if (typeof value.title !== "string" || !value.title.trim()) {
    problems.push(`${name}: "title" must be a non-empty string`);
  } else if (value.title.length > 100) {
    problems.push(`${name}: "title" is longer than 100 characters`);
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.some((item) => typeof item !== "string" || !item.trim())
  ) {
    problems.push(`${name}: "items" must be a non-empty list of non-empty strings`);
  }
  if (text.includes(EM_DASH)) problems.push(`${name}: no em dashes`);
  return problems;
}

function isFragmentPath(file) {
  return file.startsWith(`${FRAGMENT_DIR}/`) && file.endsWith(".json");
}

/** Changelog files added by the commits in a range, oldest first. */
function fragmentsAdded(git, range) {
  const out = git([
    "log",
    "--reverse",
    "--first-parent",
    // A renamed file counts as added under its new name, as check-pr sees it.
    "--no-renames",
    "--diff-filter=A",
    "--name-only",
    "--format=",
    range,
    "--",
    FRAGMENT_DIR,
  ]);
  const seen = new Set();
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => isFragmentPath(file) && !seen.has(file) && seen.add(file));
}

function readFragment(git, sha, file) {
  let text;
  try {
    text = git(["show", `${sha}:${file}`]);
  } catch {
    return null; // deleted since: it no longer shows
  }
  const problems = validateFragment(file, text);
  if (problems.length) throw new Error(problems.join("\n"));
  return JSON.parse(text);
}

function entryFor(version, date, fragments) {
  if (fragments.length === 0) return null;
  return {
    version,
    date,
    title: fragments.map((f) => f.title).join("; "),
    track: "web",
    items: fragments.flatMap((f) => f.items),
  };
}

function webTags(git, extra = []) {
  return git(["tag", "--list", `${TAG_PREFIX}*`, ...extra])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, version: name.slice(TAG_PREFIX.length) }))
    .filter((tag) => parseVersion(tag.version))
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Works out the version for deploying `ref` and the web changelog up to it.
 *
 * `git(args)` runs git in the repository and returns its output.
 * `pullRequestFor(sha)` resolves to `{ number, labels }` for the pull request
 * that merged a commit, or null for a commit pushed without one.
 *
 * @param {{
 *   git: (args: string[]) => string,
 *   ref: string,
 *   environment: string,
 *   today: string,
 *   pullRequestFor: (sha: string) => Promise<{ number: number, labels: string[] } | null>,
 *   warn?: (message: string) => void,
 * }} options
 */
export async function plan({ git, ref, environment, today, pullRequestFor, warn = () => {} }) {
  if (environment !== "production" && environment !== "dryrun") {
    throw new Error(`unknown environment: ${environment}`);
  }
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const all = webTags(git);
  const merged = webTags(git, ["--merged", sha]);
  if (merged.length === 0) {
    throw new Error(`no ${TAG_PREFIX}* tag is an ancestor of ${sha}; tag the last release first`);
  }
  const last = merged[merged.length - 1];
  const newest = all[all.length - 1];
  const tagCommit = (tag) => git(["rev-parse", `${tag.name}^{commit}`]);
  const tagDate = (tag) =>
    git(["for-each-ref", "--format=%(creatordate:short)", `refs/tags/${tag.name}`]);

  // The changelog of every release up to the last one this commit contains.
  const entries = [];
  merged.forEach((tag, i) => {
    const range = i === 0 ? tag.name : `${merged[i - 1].name}..${tag.name}`;
    const fragments = fragmentsAdded(git, range)
      .map((file) => readFragment(git, sha, file))
      .filter(Boolean);
    const entry = entryFor(tag.version, tagDate(tag), fragments);
    if (entry) entries.unshift(entry);
  });

  // Deploying a commit that is already a release: its own version again.
  if (tagCommit(last) === sha) {
    return {
      sha,
      version: last.version,
      tag: null,
      previous: last.name,
      bump: "none",
      pullRequests: [],
      entries,
    };
  }

  if (newest.name !== last.name) {
    throw new Error(
      `${sha} is behind ${newest.name}: deploy a tag to roll back, or a commit that contains ${newest.name}`
    );
  }

  const commits = git(["log", "--reverse", "--first-parent", "--format=%H", `${last.name}..${sha}`])
    .split("\n")
    .filter(Boolean);
  const pullRequests = [];
  for (const commit of commits) {
    const pr = await pullRequestFor(commit);
    const addsFragment = fragmentsAdded(git, `${commit}^..${commit}`).length > 0;
    let bump = pr ? bumpFromLabels(pr.labels) : null;
    if (bump === null) {
      bump = addsFragment ? "patch" : "none";
      warn(
        `${commit.slice(0, 12)}${pr ? ` (#${pr.number})` : ""} has no release label; counted as ${bump}`
      );
    } else if (bump === "none" && addsFragment) {
      bump = "patch";
      warn(
        `${commit.slice(0, 12)} (#${pr.number}) is release: none but adds a changelog file; counted as patch`
      );
    }
    pullRequests.push({ sha: commit, number: pr?.number ?? null, bump });
  }

  const bump = highestBump(pullRequests.map((p) => p.bump));
  if (bump === "none") {
    return {
      sha,
      version: last.version,
      tag: null,
      previous: last.name,
      bump,
      pullRequests,
      entries,
    };
  }

  const next = bumpVersion(last.version, bump);
  const fragments = fragmentsAdded(git, `${last.name}..${sha}`)
    .map((file) => readFragment(git, sha, file))
    .filter(Boolean);
  const entry = entryFor(next, today, fragments);
  if (entry) entries.unshift(entry);

  if (environment === "dryrun") {
    return {
      sha,
      version: `${next}-dryrun`,
      tag: null,
      previous: last.name,
      bump,
      pullRequests,
      entries,
    };
  }
  return {
    sha,
    version: next,
    tag: `${TAG_PREFIX}${next}`,
    previous: last.name,
    bump,
    pullRequests,
    entries,
  };
}

/**
 * What a pull request must have: exactly one release label, a changelog file
 * of its own unless it is `release: none`, and valid changelog files.
 * Returns problems as sentences; empty when the PR is fine.
 */
export function checkPullRequest({ git, base, head, labels }) {
  const problems = [];
  let bump = null;
  try {
    bump = bumpFromLabels(labels);
  } catch (error) {
    problems.push(`Pick one release label, not several (${error.message}).`);
  }
  if (bump === null && problems.length === 0) {
    problems.push(
      "Add one release label: release: patch, release: minor, release: major, or release: none for changes that ship nothing to the web app, receiver or MX host."
    );
  }

  const changed = git([
    "diff",
    "--name-status",
    "--no-renames",
    `${base}...${head}`,
    "--",
    FRAGMENT_DIR,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split("\t");
      return { status, file };
    });
  const added = changed.filter((c) => c.status === "A" && c.file !== `${FRAGMENT_DIR}/README.md`);

  if (bump && bump !== "none" && added.length === 0) {
    problems.push(
      `release: ${bump} needs a changelog file: add ${FRAGMENT_DIR}/<short-name>.json with "title" and "items".`
    );
  }
  if (bump === "none" && added.length > 0) {
    problems.push(
      "release: none ships no changelog entry: remove the new changelog file or pick patch, minor or major."
    );
  }
  for (const { status, file } of changed) {
    if (status === "D" || file === `${FRAGMENT_DIR}/README.md`) continue;
    problems.push(...validateFragment(file, git(["show", `${head}:${file}`])));
  }
  return problems;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value`);
    args[key.slice(2)] = value;
    i++;
  }
  return args;
}

function gitIn(cwd) {
  return (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(
      /\n$/,
      ""
    );
}

function githubPullRequests(repo, token) {
  return async (sha) => {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "webhooks-cc-release" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, {
      headers,
    });
    // GitHub does not know a commit that was never pushed (a local try).
    if (res.status === 422) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the pull requests of ${sha}`);
    const pulls = await res.json();
    const pr = pulls.find((p) => p.merge_commit_sha === sha) ?? pulls.find((p) => p.merged_at);
    return pr ? { number: pr.number, labels: pr.labels.map((label) => label.name) } : null;
  };
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const root = gitIn(process.cwd())(["rev-parse", "--show-toplevel"]);
  const git = gitIn(root);

  if (command === "plan") {
    if (!args.ref || !args.environment) throw new Error("plan needs --ref and --environment");
    const repo = args.repo ?? DEFAULT_REPO;
    const today = args.today ?? new Date().toISOString().slice(0, 10);
    const result = await plan({
      git,
      ref: args.ref,
      environment: args.environment,
      today,
      pullRequestFor: githubPullRequests(repo, process.env.GH_TOKEN),
      warn: (message) => console.log(`::warning::${message}`),
    });
    const out = path.resolve(root, args.out ?? RELEASE_FILE);
    writeFileSync(
      out,
      `${JSON.stringify({ version: result.version, entries: result.entries }, null, 2)}\n`
    );
    output("version", result.version);
    output("tag", result.tag ?? "");
    output("previous", result.previous);
    const prs = result.pullRequests
      .map((p) => (p.number ? `#${p.number} (${p.bump})` : `${p.sha.slice(0, 12)} (${p.bump})`))
      .join(", ");
    summary([
      `Web version **${result.version}** (${result.bump} since ${result.previous})${prs ? `: ${prs}` : ""}`,
    ]);
    console.log(`web ${result.version} (${result.bump} since ${result.previous})`);
    return;
  }

  if (command === "check-pr") {
    if (!args.base || !args.head) throw new Error("check-pr needs --base and --head");
    const labels = JSON.parse(process.env.PR_LABELS ?? "[]");
    const problems = checkPullRequest({ git, base: args.base, head: args.head, labels });
    for (const problem of problems) console.log(`::error::${problem}`);
    if (problems.length) process.exit(1);
    console.log(`Release label and changelog files are in order (${labels.join(", ")}).`);
    return;
  }

  throw new Error(`unknown command: ${command ?? "(none)"}; use plan or check-pr`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
