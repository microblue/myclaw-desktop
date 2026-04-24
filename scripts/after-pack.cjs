/**
 * after-pack.cjs
 *
 * electron-builder afterPack hook — post-packaging fixups that can't be
 * expressed in electron-builder.yml.
 *
 * The previous version of this file also hand-copied the bundled openclaw
 * runtime + its node_modules into resources/openclaw/, plus bundled four
 * channel plugins from pnpm's virtual store.  All of that is gone now:
 * MyClaw fetches the pinned openclaw into ~/.myclaw/runtime/ via `npm
 * install` on first launch (see electron/utils/openclaw_install.ts), so
 * there is nothing openclaw-related left to tidy up at pack time.
 *
 * What remains:
 *   1. Patch lru-cache inside app.asar.unpacked.  MyClaw's own deps
 *      (electron-updater → semver, posthog-node → proxy agents) pull in
 *      older CJS lru-cache that doesn't expose `LRUCache` as a named
 *      export.  Node 22+ ESM interop breaks `import { LRUCache }`.
 *      electron-builder.yml asarUnpacks lru-cache; we patch it here.
 *   2. (Windows only) Patch app-builder-lib's NSIS extractAppPackage.nsh
 *      to stream LZMA2 directly to $INSTDIR instead of going through a
 *      temp-dir + CopyFiles, which cuts install time from 3–5 minutes
 *      to ~10 seconds on Windows machines with real-time AV.
 */

const { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('fs');
const { join, relative } = require('path');

// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_MAP = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function norm_win(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  return '\\\\?\\' + p.replace(/\//g, '\\');
}

// ── 1. Patch lru-cache in app.asar.unpacked ─────────────────────────────────
function patch_lru_cache_in_asar_unpacked(asar_unpacked_dir) {
  if (!existsSync(asar_unpacked_dir)) return 0;

  let patched = 0;
  const stack = [asar_unpacked_dir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(norm_win(dir), { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const full_path = join(dir, entry.name);
      let is_dir = entry.isDirectory();
      if (!is_dir) {
        // pnpm layout may contain symlink/junction directories on Windows.
        try { is_dir = statSync(norm_win(full_path)).isDirectory(); } catch { is_dir = false; }
      }
      if (!is_dir) continue;

      if (entry.name !== 'lru-cache') {
        stack.push(full_path);
        continue;
      }

      const pkg_path = join(full_path, 'package.json');
      if (!existsSync(norm_win(pkg_path))) { stack.push(full_path); continue; }

      try {
        const pkg = JSON.parse(readFileSync(norm_win(pkg_path), 'utf8'));
        if (pkg.type === 'module') continue; // ESM already has named exports.

        const main_file = pkg.main || 'index.js';
        const cjs_entry = join(full_path, main_file);
        if (existsSync(norm_win(cjs_entry))) {
          const original = readFileSync(norm_win(cjs_entry), 'utf8');
          if (!original.includes('exports.LRUCache')) {
            const snippet = [
              '',
              '// MyClaw patch: add LRUCache named export for Node.js 22+ ESM interop',
              'if (typeof module.exports === "function" && !module.exports.LRUCache) {',
              '  module.exports.LRUCache = module.exports;',
              '}',
              '',
            ].join('\n');
            writeFileSync(norm_win(cjs_entry), original + snippet, 'utf8');
            patched++;
            console.log(`[after-pack] 🩹 Patched lru-cache CJS v${pkg.version} at ${relative(asar_unpacked_dir, full_path)}`);
          }
        }

        // lru-cache v7 ESM variant exports default only — add named export.
        const module_file = typeof pkg.module === 'string' ? pkg.module : null;
        if (module_file) {
          const esm_entry = join(full_path, module_file);
          if (existsSync(norm_win(esm_entry))) {
            const esm_original = readFileSync(norm_win(esm_entry), 'utf8');
            if (
              esm_original.includes('export default LRUCache') &&
              !esm_original.includes('export { LRUCache')
            ) {
              writeFileSync(
                norm_win(esm_entry),
                esm_original + '\n\nexport { LRUCache }\n',
                'utf8',
              );
              patched++;
              console.log(`[after-pack] 🩹 Patched lru-cache ESM v${pkg.version} at ${relative(asar_unpacked_dir, full_path)}`);
            }
          }
        }
      } catch (err) {
        console.warn(`[after-pack] ⚠️  Failed to patch lru-cache at ${full_path}:`, err.message);
      }
    }
  }

  return patched;
}

// ── 2. Copy bundled Node's node_modules (bypass electron-builder filter) ────
//
// `resources/bin/<platform>-<arch>/` holds the full extracted Node.js
// distribution that download-bundled-node.mjs produces.  Top-level
// files (node.exe, npm.cmd, npm.ps1, corepack shims, LICENSE, etc.)
// get copied into the packaged `resources/bin/` by electron-builder's
// `extraResources` rule just fine.  But the `node_modules/npm/` tree
// underneath — the actual npm package the shims execute against — is
// silently FILTERED OUT because electron-builder honours the repo's
// `.gitignore`, which excludes `node_modules/` everywhere.
//
// Observed symptom (commit 6f261b9 install-smoke): `npm.cmd` present,
// `node_modules/npm/bin/npm-cli.js` missing, every `npm` invocation
// fails.
//
// Fix: after electron-builder finishes, manually copy the
// `node_modules/` subtree from the source into the packaged resources
// directory.  Same bypass pattern the repo previously used for
// openclaw's own node_modules (which has since been removed since
// v1.5 fetches openclaw at first launch).
function copy_bundled_node_modules(context, resources_dir) {
  const platform = context.electronPlatformName;
  if (platform !== 'win32') {
    // macOS / Linux builds don't bundle a Node runtime yet (see
    // download-bundled-node.mjs — Windows-only).  Skip.
    return;
  }
  const arch = ARCH_MAP[context.arch] || 'x64';
  const source = join(__dirname, '..', 'resources', 'bin', `${platform}-${arch}`, 'node_modules');
  const dest = join(resources_dir, 'bin', 'node_modules');

  if (!existsSync(norm_win(source))) {
    console.warn(
      `[after-pack] ⚠️  ${source} not found — did \`pnpm run node:download:win\` run ` +
      `before electron-builder?  Bundled npm will be unreachable in the installed app.`,
    );
    return;
  }

  // npm's internal tree can hit Windows MAX_PATH (260).  Use \\?\ prefixed
  // paths so long-path support is not required on the build runner.
  cpSync(norm_win(source), norm_win(dest), { recursive: true });
  const npmCli = join(dest, 'npm', 'bin', 'npm-cli.js');
  console.log(`[after-pack] ✅ Bundled Node node_modules copied → ${dest}`);
  console.log(`[after-pack]    npm-cli.js at: ${npmCli} (exists=${existsSync(norm_win(npmCli))})`);
}

// ── 3. Windows NSIS extract speed patch ─────────────────────────────────────
// electron-builder's extractUsing7za macro decompresses app-64.7z into a temp
// dir, then uses CopyFiles to copy ~300MB of small files into $INSTDIR.  With
// Windows Defender real-time scanning each file, CopyFiles alone takes 3–5
// minutes and makes the installer look frozen.  We swap in a direct
// Nsis7z::Extract to $INSTDIR (safe because customCheckAppRunning in
// installer.nsh renames stale $INSTDIR to a _stale_X sibling before this runs).
function patch_nsis_extract_template(project_root) {
  const template_path = join(
    project_root, 'node_modules', 'app-builder-lib',
    'templates', 'nsis', 'include', 'extractAppPackage.nsh',
  );
  if (!existsSync(template_path)) return;

  const original = readFileSync(template_path, 'utf8');
  if (original.includes('MyClaw-patched')) {
    console.log('[after-pack] ⚡ extractAppPackage.nsh already patched (idempotent skip).');
    return;
  }
  if (!original.includes('CopyFiles')) {
    console.warn('[after-pack] ⚠️  extractAppPackage.nsh has no CopyFiles — template may have changed.');
    return;
  }

  const patched = original.replace(
    /(!macro extractUsing7za FILE[\s\S]*?!macroend)/,
    [
      '!macro extractUsing7za FILE',
      '  ; MyClaw-patched: extract directly to $INSTDIR (skip temp + CopyFiles).',
      '  ; customCheckAppRunning already renamed old $INSTDIR to _stale_X,',
      '  ; so the target directory is always empty.  Nsis7z streams LZMA2 data',
      '  ; directly to disk — ~10s vs 3-5 min for CopyFiles with Windows Defender.',
      '  Nsis7z::Extract "${FILE}"',
      '!macroend',
    ].join('\n'),
  );

  if (patched === original) {
    console.warn('[after-pack] ⚠️  extractAppPackage.nsh regex did not match.');
    return;
  }
  writeFileSync(template_path, patched, 'utf8');
  console.log('[after-pack] ⚡ Patched extractAppPackage.nsh: CopyFiles eliminated, using direct Nsis7z::Extract.');
}

// ── Main hook ────────────────────────────────────────────────────────────────

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  console.log(`[after-pack] Target: ${platform}/${context.arch}`);

  let resources_dir;
  if (platform === 'darwin') {
    const app_name = context.packager.appInfo.productFilename;
    resources_dir = join(context.appOutDir, `${app_name}.app`, 'Contents', 'Resources');
  } else {
    resources_dir = join(context.appOutDir, 'resources');
  }

  const asar_unpacked = join(resources_dir, 'app.asar.unpacked');
  const lru_patched = patch_lru_cache_in_asar_unpacked(asar_unpacked);
  if (lru_patched > 0) {
    console.log(`[after-pack] 🩹 Patched ${lru_patched} lru-cache instance(s) in app.asar.unpacked`);
  }

  copy_bundled_node_modules(context, resources_dir);

  if (platform === 'win32') {
    patch_nsis_extract_template(join(__dirname, '..'));
  }
};
