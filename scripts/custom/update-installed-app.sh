#!/bin/bash

set -euo pipefail

repo_dir="${T3CODE_CUSTOM_REPO:-/Users/tf-work/Desktop/t3code-custom}"
state_dir="${T3CODE_CUSTOM_UPDATER_HOME:-/Users/tf-work/.t3/custom-updater}"
vp_bin="${T3CODE_CUSTOM_VP_BIN:-/Users/tf-work/.vite-plus/bin/vp}"
database="${T3CODE_CUSTOM_DATABASE:-/Users/tf-work/.t3/userdata/state.sqlite}"
destination="/Applications/T3 Code Custom.app"
custom_bundle_id="com.taufeeque.t3code-custom"
official_bundle_id="com.t3tools.t3code"
mode="${1:---update}"

mkdir -p "$state_dir" "$state_dir/builds" "$state_dir/backups"

log() {
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

read_state() {
  local path="$1"
  if [[ -f "$path" ]]; then
    tr -d '[:space:]' < "$path"
  fi
}

active_session_count() {
  if [[ ! -f "$database" ]]; then
    printf '0\n'
    return
  fi
  sqlite3 -readonly "$database" \
    "SELECT COUNT(*) FROM provider_session_runtime WHERE status IN ('starting', 'running');"
}

application_is_running() {
  local bundle_id="$1"
  [[ "$(osascript -e "application id \"$bundle_id\" is running" 2>/dev/null || printf 'false\n')" == "true" ]]
}

desired_commit="$(git -C "$repo_dir" ls-remote origin refs/heads/custom | awk '{print $1}')"
if [[ -z "$desired_commit" ]]; then
  log "No custom branch was found on origin."
  exit 1
fi

installed_commit="$(read_state "$state_dir/installed-commit")"
built_commit="$(read_state "$state_dir/built-commit")"
active_sessions="$(active_session_count)"

if [[ "$mode" == "--status" ]]; then
  app_installed=false
  if [[ -d "$destination" ]]; then
    app_installed=true
  fi
  printf '%s\n' "desired_commit=$desired_commit"
  printf '%s\n' "built_commit=${built_commit:-none}"
  printf '%s\n' "installed_commit=${installed_commit:-none}"
  printf '%s\n' "active_sessions=$active_sessions"
  printf '%s\n' "app_installed=$app_installed"
  exit 0
fi

lock_dir="$state_dir/update.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  log "Another updater process is already running."
  exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

if [[ "$installed_commit" == "$desired_commit" && -d "$destination" ]]; then
  log "T3 Code Custom is already current at ${desired_commit:0:12}."
  exit 0
fi

if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
  log "The custom checkout has local changes; refusing to update it automatically."
  exit 1
fi
if [[ "$(git -C "$repo_dir" branch --show-current)" != "custom" ]]; then
  log "The custom checkout is not on the custom branch; refusing to switch it automatically."
  exit 1
fi

git -C "$repo_dir" fetch origin custom
git -C "$repo_dir" merge --ff-only origin/custom

build_dir="$state_dir/builds/$desired_commit"
staged_app="$build_dir/T3 Code Custom.app"
if [[ "$built_commit" != "$desired_commit" || ! -d "$staged_app" ]]; then
  attempt_dir="$(mktemp -d "$state_dir/build-attempt.XXXXXX")"
  mount_dir="$(mktemp -d "$state_dir/mount.XXXXXX")"
  mounted=false
  cleanup_attempt() {
    if [[ "$mounted" == "true" ]]; then
      hdiutil detach "$mount_dir" -quiet 2>/dev/null || true
    fi
    rmdir "$mount_dir" 2>/dev/null || true
    if [[ -d "$attempt_dir" ]]; then
      rm -rf "$attempt_dir"
    fi
  }
  trap 'cleanup_attempt; rmdir "$lock_dir" 2>/dev/null || true' EXIT

  log "Building T3 Code Custom at ${desired_commit:0:12}."
  (
    cd "$repo_dir"
    "$vp_bin" install --frozen-lockfile
    env -u GITHUB_REPOSITORY \
      T3CODE_DESKTOP_UPDATE_REPOSITORY="" \
      T3CODE_DESKTOP_OUTPUT_DIR="$attempt_dir" \
      "$vp_bin" run dist:desktop:dmg:arm64
  )

  dmg_path="$(find "$attempt_dir" -maxdepth 1 -type f -name 'T3-Code-Custom-*.dmg' -print -quit)"
  if [[ -z "$dmg_path" ]]; then
    log "The build completed without producing the custom DMG."
    exit 1
  fi
  hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
  mounted=true
  source_app="$mount_dir/T3 Code Custom.app"
  if [[ ! -d "$source_app" ]]; then
    log "The DMG does not contain T3 Code Custom.app."
    exit 1
  fi

  mkdir -p "$build_dir"
  ditto "$source_app" "$staged_app"
  codesign --force --deep --sign - "$staged_app"
  codesign --verify --deep --strict "$staged_app"
  actual_bundle_id="$(defaults read "$staged_app/Contents/Info" CFBundleIdentifier)"
  if [[ "$actual_bundle_id" != "$custom_bundle_id" ]]; then
    log "Unexpected bundle id: $actual_bundle_id"
    exit 1
  fi
  printf '%s\n' "$desired_commit" > "$state_dir/built-commit"
  built_commit="$desired_commit"
  cleanup_attempt
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
fi

active_sessions="$(active_session_count)"
if (( active_sessions > 0 )); then
  rm -f "$state_dir/idle-since"
  log "Build is ready, but $active_sessions provider session(s) are active. Installation deferred."
  exit 0
fi

now_epoch="$(date +%s)"
idle_since="$(read_state "$state_dir/idle-since")"
if [[ -z "$idle_since" ]]; then
  printf '%s\n' "$now_epoch" > "$state_dir/idle-since"
  log "No sessions are active. Installation will proceed on the next check after the idle grace period."
  exit 0
fi
if (( now_epoch - idle_since < 600 )); then
  log "Waiting for the 10-minute idle grace period before restarting T3 Code."
  exit 0
fi

restart_after_install=false
if application_is_running "$custom_bundle_id"; then
  restart_after_install=true
  osascript -e "tell application id \"$custom_bundle_id\" to quit"
elif [[ ! -d "$destination" ]] && application_is_running "$official_bundle_id"; then
  restart_after_install=true
  osascript -e "tell application id \"$official_bundle_id\" to quit"
fi

for _ in {1..30}; do
  if ! application_is_running "$custom_bundle_id" && ! application_is_running "$official_bundle_id"; then
    break
  fi
  sleep 1
done
if application_is_running "$custom_bundle_id" || application_is_running "$official_bundle_id"; then
  log "T3 Code did not quit cleanly; leaving the current installation untouched."
  exit 1
fi

backup_path=""
if [[ -d "$destination" ]]; then
  backup_path="$state_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-T3 Code Custom.app"
  mv "$destination" "$backup_path"
fi

if ! ditto "$staged_app" "$destination"; then
  if [[ -n "$backup_path" && -d "$backup_path" ]]; then
    mv "$backup_path" "$destination"
  fi
  log "Installation failed; the previous app was restored."
  exit 1
fi
codesign --verify --deep --strict "$destination"
printf '%s\n' "$desired_commit" > "$state_dir/installed-commit"
rm -f "$state_dir/idle-since"
log "Installed T3 Code Custom at ${desired_commit:0:12}."

if [[ "$restart_after_install" == "true" ]]; then
  open -b "$custom_bundle_id"
  log "Restarted T3 Code Custom."
fi
