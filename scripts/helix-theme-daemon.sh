#!/bin/bash

# Helix Theme Daemon - Automatically sync Helix theme with system appearance

HELIX_CONFIG="$HOME/.config/helix/config.toml"
LOCK_FILE="/tmp/helix-theme-daemon.lock"

# Daemonize if not already running in background
if [ "$1" != "--daemon" ]; then
    # Start in background and exit
    nohup "$0" --daemon > /tmp/helix-theme-daemon.log 2> /tmp/helix-theme-daemon.error.log &
    echo "Helix theme daemon started in background (PID: $!)"
    exit 0
fi

# Function to get current system theme
get_system_theme() {
    if defaults read -g AppleInterfaceStyle 2>/dev/null | grep -q "Dark"; then
        echo "dark"
    else
        echo "light"
    fi
}

# Function to update Helix theme
update_helix_theme() {
    local theme_variant="$1"
    if [ "$theme_variant" = "light" ]; then
        local helix_theme="gruvbox_light_hard"
    else
        local helix_theme="gruvbox_dark_hard"
    fi
    
    if [ -f "$HELIX_CONFIG" ]; then
        if command -v gsed >/dev/null 2>&1; then
            gsed -i "/theme =/c\\theme = \"$helix_theme\"" "$HELIX_CONFIG"
        else
            sed -i '' "/theme =/s/.*/theme = \"$helix_theme\"/" "$HELIX_CONFIG"
        fi
        echo "$(date): Updated Helix theme to $helix_theme"
    fi
}

# Check if daemon is already running
if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
    echo "Helix theme daemon is already running (PID: $(cat "$LOCK_FILE"))"
    exit 1
fi

# Create lock file
echo $$ > "$LOCK_FILE"

# Cleanup on exit
trap 'rm -f "$LOCK_FILE"; exit' INT TERM EXIT

echo "Starting Helix theme daemon..."
echo "Monitoring system appearance changes..."

# Set initial theme
current_theme=$(get_system_theme)
update_helix_theme "$current_theme"

# Monitor system preferences for changes
fswatch -o ~/Library/Preferences/.GlobalPreferences.plist 2>/dev/null | while read -r; do
    new_theme=$(get_system_theme)
    if [ "$new_theme" != "$current_theme" ]; then
        current_theme="$new_theme"
        update_helix_theme "$current_theme"
    fi
done