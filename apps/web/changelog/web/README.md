# Web changelog files

Each pull request that changes what the web app, receiver or MX host ship adds
one file here, named after the change (`docs-on-mailhooks.json`):

```json
{
  "title": "Docs on mailhooks.cc",
  "items": ["mailhooks.cc serves the docs itself, under its own header and footer"]
}
```

It never names a version. The pull request carries one label instead:
`release: patch`, `release: minor`, `release: major`, or `release: none` for a
change that ships nothing (and then adds no file here). The `Release label`
check enforces both.

The version is given when a release is deployed: `apps/web/scripts/release.mjs`
takes the last `web-v*` tag, applies the highest bump among the pull requests
merged since, and files every changelog file under the first release that
shipped it. A file can still be edited after its release; the changelog shows
it as it reads at the deployed commit.
