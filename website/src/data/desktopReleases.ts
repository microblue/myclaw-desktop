// Changelog for the MyClaw.One desktop app, auto-distilled from commit
// history between tags in microblue/myclaw-desktop. Each bump here should
// match a published release at
// https://github.com/microblue/myclaw-desktop-releases/releases.

export type DesktopChangeKind = 'highlight' | 'fix'

export interface DesktopChange {
    kind: DesktopChangeKind
    text: string
}

export interface DesktopRelease {
    version: string
    date: string // ISO yyyy-mm-dd
    changes: DesktopChange[]
}

const DESKTOP_RELEASES: DesktopRelease[] = [
    {
        version: '1.6.2',
        date: '2026-04-28',
        changes: [
            {
                kind: 'fix',
                text: 'Fixed runtime install crash on Windows machines without a global Node.js installation (preinstall script could not find \'node\' on PATH).'
            },
            {
                kind: 'highlight',
                text: 'Initialization splash now shows a progress bar with a live stage label and scrolling install log, so first-launch progress is visible at a glance.'
            }
        ]
    },
    {
        version: '1.6.1',
        date: '2026-04-28',
        changes: [
            {
                kind: 'fix',
                text: 'Fixed a crash on first launch on Windows where the app would silently exit after installing the runtime, before the gateway could start.'
            },
            {
                kind: 'fix',
                text: 'Hardened main-process startup with crash handlers so any future top-level errors surface cleanly instead of leaving the app idle.'
            }
        ]
    },
    {
        version: '1.6.0',
        date: '2026-04-24',
        changes: [
            {
                kind: 'highlight',
                text: 'MyClaw is now a dashboard, not a fork — we no longer patch openclaw at build time or write into `~/.openclaw/extensions/`. First launch fetches the pinned openclaw via `npm install` and starts it with a minimal config; everything else is openclaw’s own runtime defaults plus whatever you configure through the UI.'
            },
            {
                kind: 'highlight',
                text: 'Version range instead of exact pin — if you upgrade openclaw yourself, MyClaw respects it (within a tested-compatible range) instead of clobbering your install.'
            },
            {
                kind: 'highlight',
                text: 'Plugin install delegated to `openclaw plugins install` — we don’t copy local files anymore, we just ask the CLI.  Matches what upstream expects.'
            }
        ]
    },
    {
        version: '1.5.0',
        date: '2026-04-23',
        changes: [
            {
                kind: 'highlight',
                text: 'Stripped bundled openclaw — first launch fetches the pinned version into `~/.myclaw/runtime/` via bundled Node + npm.  Installer is smaller and you always get the openclaw version this release was tested with.'
            },
            {
                kind: 'highlight',
                text: 'Splash-style progress window during first-launch init — shows npm install progress so you know it’s not frozen.'
            },
            {
                kind: 'highlight',
                text: 'Bundled npm with Node so subsequent updates can `npm install` without needing a system Node toolchain.'
            }
        ]
    },
    {
        version: '1.4.4',
        date: '2026-04-23',
        changes: [
            {
                kind: 'highlight',
                text: 'Reset your OpenClaw data from the app menu — wipes `~/.openclaw` (config, memory, skills) with a confirmation dialog on macOS, Linux and Windows. Useful when an agent\u2019s state is corrupt or you just want a clean slate.'
            },
            {
                kind: 'highlight',
                text: 'Opt-in reset during Windows install/uninstall — a new wizard page lets you wipe `~/.openclaw` when upgrading or removing the app. Unchecked by default; your data stays put unless you ask.'
            },
            {
                kind: 'fix',
                text: 'Windows installer: fixed three NSIS regressions from the reset feature (`FileFunc.nsh` include, page function scoping, `${isUpdated}` evaluation) so the installer builds and runs cleanly.'
            }
        ]
    },
    {
        version: '1.4.3',
        date: '2026-04-22',
        changes: [
            {
                kind: 'highlight',
                text: 'Maintenance release with assorted under-the-hood improvements and updated dependencies. See the GitHub release page for the full asset list (Windows, Linux x64/ARM64 AppImage / .deb / .rpm).'
            }
        ]
    },
    {
        version: '1.4.2',
        date: '2026-04-19',
        changes: [
            {
                kind: 'highlight',
                text: 'Sleep prevention (opt-in) — keeps the OS awake while MyClaw is running so long-lived messaging channels don\u2019t drop when the machine would otherwise sleep. Off by default to protect laptop batteries.'
            },
            {
                kind: 'highlight',
                text: 'Smart reconnect after wake — Gateway is restarted automatically when its WebSocket is still dead after a Windows suspend/resume, instead of waiting out the heartbeat timeout.'
            },
            {
                kind: 'highlight',
                text: 'Windows power-outage recovery — first-run guide to enable launch-at-startup and auto-login so MyClaw is back up on its own after an unexpected reboot. Revisitable from the tray menu.'
            }
        ]
    },
    {
        version: '1.4.1',
        date: '2026-04-18',
        changes: [
            {
                kind: 'fix',
                text: 'Fixed Windows Gateway hang after 1.4.0 — disabled the Bonjour/mDNS advertiser that was stalling the startup handshake on machines with Apple Bonjour, VPN, or Hyper-V network adapters (symptom: 20-second connect timeout loop).'
            }
        ]
    },
    {
        version: '1.4.0',
        date: '2026-04-16',
        changes: [
            {
                kind: 'highlight',
                text: 'Upgraded OpenClaw runtime to 2026.4.12.'
            },
            {
                kind: 'highlight',
                text: 'Updated channel plugins: WeChat 2.1.8 and Lark / WeCom / DingTalk to their latest stable releases.'
            }
        ]
    },
    {
        version: '1.2.0',
        date: '2026-04-07',
        changes: [
            {
                kind: 'highlight',
                text: 'Compatible with OpenClaw 2026.4.5\u2019s new channel SDK layout (Discord, Telegram, Slack, WhatsApp). Falls back to 4.2 paths automatically for older Gateways.'
            },
            {
                kind: 'fix',
                text: 'Discord guild config migration — the old per-channel `allow` flag is rewritten to the new `enabled` shape on startup so Gateway stops failing config validation.'
            },
            {
                kind: 'fix',
                text: 'Bundler reliability on Windows: corrected promotion ordering and surfaced previously-silent dependency copy errors.'
            }
        ]
    },
    {
        version: '1.1.7',
        date: '2026-04-07',
        changes: [
            {
                kind: 'fix',
                text: 'WhatsApp login no longer stalls at the end of pairing — fixed a credential/connection race that caused a ~15-second hang before the flow completed.'
            },
            {
                kind: 'fix',
                text: 'Dev-mode startup loads the right OpenClaw build (with all bundled dependencies) instead of the pnpm internal store, which was missing ~379 runtime deps.'
            },
            {
                kind: 'fix',
                text: 'QQ Bot and Feishu plugins now bundle into the correct directory names.'
            },
            {
                kind: 'highlight',
                text: 'Plugin bundling supports decoupled directory name vs plugin id, unblocking plugins whose manifest id differs from their folder.'
            }
        ]
    },
    {
        version: '1.1.6',
        date: '2026-04-06',
        changes: [
            {
                kind: 'highlight',
                text: 'First release tracked in this changelog. Earlier beta history is available on GitHub.'
            }
        ]
    }
]

export default DESKTOP_RELEASES