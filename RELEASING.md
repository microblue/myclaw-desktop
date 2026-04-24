# Releasing MyClaw.One Desktop

This repo ships two deliverables per release:

1. The Electron app (GitHub Releases on `microblue/myclaw-desktop-releases`)
2. The marketing site [`desktop.myclaw.one`](https://desktop.myclaw.one) (Vercel)

Both are kept in sync by a single bump script.

## One-command bump

```bash
node scripts/release-bump.mjs 1.7.0 \
  --highlight "New feature A — description shown in the changelog." \
  --highlight "New feature B" \
  --fix "Fixed a crash when X"
```

This touches exactly three files:

| File | What changes |
| --- | --- |
| `package.json` | `"version"` bumped |
| `website/src/data/desktopReleases.ts` | New release entry prepended (auto-dated to today, ISO) |
| `website/src/components/DesktopContent.astro` | `DOWNLOAD_VERSION` constant bumped (drives the download-button URLs and "v1.7.0" stat) |

Alternatively, pass a JSON file:

```bash
cat > /tmp/changes-1.7.0.json <<'JSON'
[
  { "kind": "highlight", "text": "…" },
  { "kind": "fix",       "text": "…" }
]
JSON
node scripts/release-bump.mjs 1.7.0 --changes /tmp/changes-1.7.0.json
```

## Commit + tag + push

```bash
git add package.json \
        website/src/data/desktopReleases.ts \
        website/src/components/DesktopContent.astro
git commit -m "release: 1.7.0"
git tag v1.7.0
git push origin main --tags
```

## What happens automatically after push

1. **Website** — Vercel watches `main` on `microblue/myclaw-desktop` and
   redeploys `website/` on every push.  New changelog entry and download
   version on `desktop.myclaw.one` within ~60 seconds.
2. **Electron app** — GitHub Actions (existing release workflow) builds
   Windows/Linux artifacts against the `v1.7.0` tag and publishes them
   to `microblue/myclaw-desktop-releases`.

**Note:** Website auto-deploy only kicks in once the Vercel GitHub App
is installed on this repo.  Until then, manually redeploy with:

```bash
cd website && pnpm build
vercel deploy --prod --yes \
  --name myclaw-desktop-website \
  --cwd dist \
  --scope team_4Xyd56Wr20KGnCryg7GW4Yeo \
  --token "$VERCEL_TOKEN"
```
