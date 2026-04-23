#!/bin/bash

# Post-removal script for MyClaw on Linux

set -e

# Remove symbolic links
rm -f /usr/local/bin/clawx 2>/dev/null || true
rm -f /usr/local/bin/openclaw 2>/dev/null || true

# Update desktop database
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database -q /usr/share/applications || true
fi

# Update icon cache
if command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi

# Remove AppArmor profile
APPARMOR_PROFILE_TARGET='/etc/apparmor.d/clawx'
if [ -f "$APPARMOR_PROFILE_TARGET" ]; then
    rm -f "$APPARMOR_PROFILE_TARGET"
fi

# Opt-in purge of the OpenClaw data folder (config, skills, caches).
# Set MYCLAW_PURGE_OPENCLAW=1 before `apt remove` / `dpkg -r` to trigger it.
# Default is off — normal removes preserve user data for reinstallation.
# Scope: the invoking user (SUDO_USER if present, else root) — we don't
# enumerate /home/* because silently wiping other users' data would surprise
# admins on shared machines.
if [ "${MYCLAW_PURGE_OPENCLAW:-0}" = "1" ]; then
    TARGET_USER="${SUDO_USER:-root}"
    TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
    if [ -n "$TARGET_HOME" ] && [ -d "$TARGET_HOME/.openclaw" ]; then
        echo "MYCLAW_PURGE_OPENCLAW=1 set — removing $TARGET_HOME/.openclaw"
        rm -rf "$TARGET_HOME/.openclaw"
    fi
fi

echo "MyClaw has been removed."
