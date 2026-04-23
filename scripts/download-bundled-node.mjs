#!/usr/bin/env zx

// Downloads Node.js + npm for Windows targets and unpacks them into
// resources/bin/<platform>-<arch>/.  The packaged MyClaw installer carries
// this tree so that first-run runtime install can run
//
//   <bundled_node> <npm-cli.js> install openclaw@<pin>
//
// without depending on the user having Node on their system.
//
// Prior versions extracted ONLY node.exe and discarded the rest of the
// distribution — which left us with no npm.  This script now preserves
// the full Node archive contents.

import 'zx/globals';

const ROOT_DIR = path.resolve(__dirname, '..');
// Bumped to Node 24 to match the CI toolchain (all workflows use
// actions/setup-node with node-version: 24).  Prior 22.16.0 was a drift
// that shipped a different ABI than what the dev/CI workflows validated.
const NODE_VERSION = '24.0.0';
const BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;
const OUTPUT_BASE = path.join(ROOT_DIR, 'resources', 'bin');

// Items a Windows Node.js zip drops at its top level.  We selectively
// remove these before extraction so that siblings placed by other scripts
// (uv.exe from download-bundled-uv.mjs, etc.) survive.
const NODE_TOP_LEVEL_ITEMS = [
  'node.exe',
  'npm', 'npm.cmd', 'npm.ps1',
  'npx', 'npx.cmd', 'npx.ps1',
  'corepack', 'corepack.cmd', 'corepack.ps1',
  'node_modules',
  'nodevars.bat',
  'install_tools.bat',
  'CHANGELOG.md', 'LICENSE', 'README.md',
];

const TARGETS = {
  'win32-x64': {
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    source_dir: `node-v${NODE_VERSION}-win-x64`,
  },
  'win32-arm64': {
    filename: `node-v${NODE_VERSION}-win-arm64.zip`,
    source_dir: `node-v${NODE_VERSION}-win-arm64`,
  },
};

const PLATFORM_GROUPS = {
  win: ['win32-x64', 'win32-arm64'],
};

async function setup_target(id) {
  const target = TARGETS[id];
  if (!target) {
    echo(chalk.yellow`⚠️ Target ${id} is not supported by this script.`);
    return;
  }

  const target_dir = path.join(OUTPUT_BASE, id);
  const temp_dir = path.join(ROOT_DIR, 'temp_node_extract');
  const archive_path = path.join(ROOT_DIR, target.filename);
  const download_url = `${BASE_URL}/${target.filename}`;

  echo(chalk.blue`\n📦 Setting up Node.js + npm for ${id}...`);

  // Selectively remove old Node distribution items, preserving uv.exe and
  // anything else sibling scripts deposited here.
  for (const name of NODE_TOP_LEVEL_ITEMS) {
    await fs.remove(path.join(target_dir, name));
  }
  await fs.remove(temp_dir);
  await fs.ensureDir(target_dir);
  await fs.ensureDir(temp_dir);

  try {
    echo`⬇️ Downloading: ${download_url}`;
    const response = await fetch(download_url);
    if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(archive_path, Buffer.from(buffer));

    echo`📂 Extracting...`;
    if (os.platform() === 'win32') {
      const { execFileSync } = await import('child_process');
      const ps_command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archive_path.replace(/'/g, "''")}', '${temp_dir.replace(/'/g, "''")}')`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps_command], { stdio: 'inherit' });
    } else {
      await $`unzip -q -o ${archive_path} -d ${temp_dir}`;
    }

    const extracted_root = path.join(temp_dir, target.source_dir);
    if (!(await fs.pathExists(extracted_root))) {
      throw new Error(`Extracted directory not found: ${extracted_root}`);
    }

    // Move ALL contents (node.exe + npm + node_modules/npm/ + shims) into
    // the target dir.  This is what the prior version missed — it only
    // pulled node.exe and silently dropped npm, leaving first-run install
    // with no package manager on Windows.
    const entries = await fs.readdir(extracted_root);
    let moved = 0;
    for (const entry of entries) {
      await fs.move(
        path.join(extracted_root, entry),
        path.join(target_dir, entry),
        { overwrite: true },
      );
      moved++;
    }

    echo(chalk.green`✅ Success: ${target_dir} (${moved} top-level items, incl. node.exe + npm)`);
  } finally {
    await fs.remove(archive_path);
    await fs.remove(temp_dir);
  }
}

const download_all = argv.all;
const platform_arg = argv.platform;

if (download_all) {
  echo(chalk.cyan`🌐 Downloading Node.js + npm for all Windows targets...`);
  for (const id of Object.keys(TARGETS)) {
    await setup_target(id);
  }
} else if (platform_arg) {
  const targets = PLATFORM_GROUPS[platform_arg];
  if (!targets) {
    echo(chalk.red`❌ Unknown platform: ${platform_arg}`);
    echo(`Available platforms: ${Object.keys(PLATFORM_GROUPS).join(', ')}`);
    process.exit(1);
  }
  echo(chalk.cyan`🎯 Downloading Node.js + npm for platform: ${platform_arg}`);
  for (const id of targets) {
    await setup_target(id);
  }
} else {
  const current_id = `${os.platform()}-${os.arch()}`;
  if (TARGETS[current_id]) {
    echo(chalk.cyan`💻 Detected Windows system: ${current_id}`);
    await setup_target(current_id);
  } else {
    echo(chalk.cyan`🎯 Defaulting to Windows multi-arch Node.js + npm download`);
    for (const id of PLATFORM_GROUPS.win) {
      await setup_target(id);
    }
  }
}

echo(chalk.green`\n🎉 Done!`);
