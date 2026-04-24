#!/usr/bin/env node
/**
 * release-bump.mjs — one-shot release bumping for MyClaw.One Desktop.
 *
 * Given a new version and a list of changelog entries, this script:
 *   1. Updates `package.json` version
 *   2. Prepends a new entry to `website/src/data/desktopReleases.ts`
 *   3. Updates the DOWNLOAD_VERSION constant inside
 *      `website/src/components/DesktopContent.astro`
 *
 * Usage:
 *   node scripts/release-bump.mjs <version> \
 *     --highlight "First highlight change text" \
 *     --highlight "Second highlight" \
 *     --fix "Some bug fix"
 *
 *   # Non-interactive CI-friendly form:
 *   node scripts/release-bump.mjs 1.7.0 \
 *     --changes ./CHANGES_1.7.0.json
 *
 * After this runs, commit the three files + tag + push.  Vercel
 * auto-deploys website/ on every push (once GitHub App is installed),
 * so the desktop.myclaw.one site picks up the new changelog entry and
 * download buttons without any other action.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function parseArgs(argv) {
    const args = argv.slice(2);
    if (args.length === 0) return { version: null, changes: [] };
    const [version, ...rest] = args;
    const changes = [];
    let changesFile = null;
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        const val = rest[i + 1];
        if (flag === '--highlight' && val) {
            changes.push({ kind: 'highlight', text: val });
            i++;
        } else if (flag === '--fix' && val) {
            changes.push({ kind: 'fix', text: val });
            i++;
        } else if (flag === '--changes' && val) {
            changesFile = val;
            i++;
        } else {
            console.error(`Unknown flag: ${flag}`);
            process.exit(2);
        }
    }
    return { version, changes, changesFile };
}

async function loadChangesFile(filePath) {
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const raw = await readFile(abs, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('--changes JSON must be an array of {kind, text}');
    for (const c of data) {
        if (!c || (c.kind !== 'highlight' && c.kind !== 'fix') || typeof c.text !== 'string') {
            throw new Error('Each --changes entry must have kind: "highlight"|"fix" and text: string');
        }
    }
    return data;
}

function bumpPackageJson(version) {
    return async () => {
        const path = join(ROOT, 'package.json');
        const raw = await readFile(path, 'utf8');
        // Preserve formatting by surgical string replace on the first "version": line
        const updated = raw.replace(
            /"version":\s*"[^"]+"/,
            `"version": "${version}"`,
        );
        if (updated === raw) throw new Error('package.json version line not found');
        await writeFile(path, updated, 'utf8');
        return path;
    };
}

function escapeForJsString(s) {
    // Match the desktopReleases.ts formatting: single-quoted strings with
    // escaped apostrophes and no double-quote escaping.
    return s
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n');
}

function prependReleaseEntry(version, changes) {
    return async () => {
        const path = join(ROOT, 'website/src/data/desktopReleases.ts');
        const raw = await readFile(path, 'utf8');
        const marker = 'const DESKTOP_RELEASES: DesktopRelease[] = [';
        const idx = raw.indexOf(marker);
        if (idx === -1) throw new Error('desktopReleases.ts: marker not found');
        const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
        const entry = [
            '    {',
            `        version: '${version}',`,
            `        date: '${today}',`,
            '        changes: [',
            ...changes.map((c) => [
                '            {',
                `                kind: '${c.kind}',`,
                `                text: '${escapeForJsString(c.text)}'`,
                '            }',
            ].join('\n')).join(',\n').split('\n'),
            '        ]',
            '    },',
            '',
        ].join('\n');
        const insertionPoint = idx + marker.length + 1; // after the '[\n'
        const updated = raw.slice(0, insertionPoint) + entry + raw.slice(insertionPoint);
        await writeFile(path, updated, 'utf8');
        return path;
    };
}

function updateDesktopContentVersion(version) {
    return async () => {
        const path = join(ROOT, 'website/src/components/DesktopContent.astro');
        const raw = await readFile(path, 'utf8');
        const updated = raw.replace(
            /const DOWNLOAD_VERSION = '[^']+';/,
            `const DOWNLOAD_VERSION = '${version}';`,
        );
        if (updated === raw) throw new Error('DesktopContent.astro: DOWNLOAD_VERSION line not found');
        await writeFile(path, updated, 'utf8');
        return path;
    };
}

async function main() {
    const { version, changes, changesFile } = parseArgs(process.argv);
    if (!version) {
        console.error('Usage: release-bump.mjs <version> [--highlight TEXT] [--fix TEXT] [--changes PATH]');
        process.exit(2);
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        console.error(`Version must be in semver form (e.g. 1.7.0), got: ${version}`);
        process.exit(2);
    }
    const finalChanges = changesFile ? await loadChangesFile(changesFile) : changes;
    if (finalChanges.length === 0) {
        console.error('At least one --highlight or --fix (or --changes path) is required.');
        process.exit(2);
    }

    const steps = [
        { label: 'package.json version',                 run: bumpPackageJson(version) },
        { label: 'website/src/data/desktopReleases.ts',  run: prependReleaseEntry(version, finalChanges) },
        { label: 'website DesktopContent DOWNLOAD_VERSION', run: updateDesktopContentVersion(version) },
    ];

    for (const step of steps) {
        const path = await step.run();
        console.log(`  ✓ ${step.label}  →  ${path}`);
    }
    console.log(`\nDone.  Version ${version} staged across 3 files.`);
    console.log('Next:');
    console.log(`  git add package.json website/src/data/desktopReleases.ts website/src/components/DesktopContent.astro`);
    console.log(`  git commit -m "release: ${version}"`);
    console.log(`  git tag v${version}`);
    console.log(`  git push origin main --tags`);
    console.log('\nVercel will auto-deploy website/ on push (once GitHub App is installed).');
}

main().catch((err) => {
    console.error(`release-bump failed: ${err.message}`);
    process.exit(1);
});
