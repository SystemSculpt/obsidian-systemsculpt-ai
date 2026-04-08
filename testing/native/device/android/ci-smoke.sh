#!/usr/bin/env bash
# Android E2E smoke test script for CI.
# Extracted from the workflow inline script because
# reactivecircus/android-emulator-runner splits multi-line scripts into
# individual `sh -c` calls, breaking for-loops and if-blocks.
set -eu

echo "--- Waiting for emulator boot ---"
adb wait-for-device
boot_complete=""
for i in $(seq 1 60); do
  boot_complete=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [ "$boot_complete" = "1" ]; then
    echo "Emulator booted after ${i}s"
    break
  fi
  sleep 1
done
if [ "$boot_complete" != "1" ]; then
  echo "ERROR: Emulator did not boot within 60s"
  exit 1
fi

echo "--- Installing Obsidian APK ---"
adb install -r ~/obsidian-installer/Obsidian-${OBSIDIAN_VERSION}.apk
echo "Obsidian installed"

echo "--- Preparing vault on device ---"
vault_path="/storage/emulated/0/Documents/SystemSculptAndroidQA"
plugin_dir="${vault_path}/.obsidian/plugins/systemsculpt-ai"

adb shell "mkdir -p '${plugin_dir}'"
adb push main.js "${plugin_dir}/main.js"
adb push manifest.json "${plugin_dir}/manifest.json"
adb push styles.css "${plugin_dir}/styles.css"

echo '["systemsculpt-ai"]' > /tmp/community-plugins.json
adb push /tmp/community-plugins.json "${vault_path}/.obsidian/community-plugins.json"
echo '{}' > /tmp/app.json
adb push /tmp/app.json "${vault_path}/.obsidian/app.json"

node --input-type=module -e "
  import fs from 'node:fs';
  const settings = {
    settingsMode: 'advanced',
    selectedModelId: 'systemsculpt@@systemsculpt/ai-agent',
  };
  const licenseKey = process.env.SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY || '';
  const serverUrl = process.env.SYSTEMSCULPT_RUNTIME_SMOKE_SERVER_URL || '';
  if (licenseKey) settings.licenseKey = licenseKey;
  if (serverUrl) settings.systemSculptServerUrl = serverUrl;
  fs.writeFileSync('/tmp/data.json', JSON.stringify(settings, null, 2));
"
adb push /tmp/data.json "${plugin_dir}/data.json"

echo '# SystemSculpt Android QA' > /tmp/Welcome.md
adb push /tmp/Welcome.md "${vault_path}/Welcome.md"
echo "Vault prepared at ${vault_path}"

echo "--- Granting storage permissions ---"
adb shell pm grant md.obsidian android.permission.READ_EXTERNAL_STORAGE 2>/dev/null || true
adb shell pm grant md.obsidian android.permission.WRITE_EXTERNAL_STORAGE 2>/dev/null || true
adb shell pm grant md.obsidian android.permission.MANAGE_EXTERNAL_STORAGE 2>/dev/null || true

echo "--- Launching Obsidian ---"
adb shell am start -n md.obsidian/.MainActivity \
  -d "obsidian://open?vault=SystemSculptAndroidQA" \
  --activity-clear-top
echo "Obsidian launched"

echo "--- Waiting for Obsidian to settle ---"
sleep 15

echo "--- Checking Obsidian process ---"
obsidian_pid=$(adb shell pidof md.obsidian 2>/dev/null | tr -d '\r')
if [ -z "${obsidian_pid}" ]; then
  echo "ERROR: Obsidian process not found"
  adb logcat -d -s "Obsidian" "*:E" | tail -50
  exit 1
fi
echo "Obsidian running with PID: ${obsidian_pid}"

echo "--- Setting up WebView debug bridge ---"
adb forward tcp:9333 "localabstract:webview_devtools_remote_${obsidian_pid}"
echo "WebView debug bridge established on localhost:9333"

echo "--- Checking WebView targets ---"
for i in $(seq 1 10); do
  targets=$(curl -s http://127.0.0.1:9333/json/list 2>/dev/null || true)
  if [ -n "${targets}" ] && [ "${targets}" != "[]" ]; then
    echo "WebView targets found"
    break
  fi
  echo "Waiting for WebView targets (${i}/10)..."
  sleep 3
done

echo "--- Running runtime smoke tests ---"
node --experimental-websocket testing/native/runtime-smoke/run.mjs \
  --mode android \
  --android-serial emulator-5554 \
  --android-forward-port 9333 \
  --case chat-exact
