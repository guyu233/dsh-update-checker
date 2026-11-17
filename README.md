# Upstream update check

While the desktop development channel is selected, Settings → General shows **Check for updates** directly under **Update channel**.

The packaged updater hides a build when this machine falls outside the feed's staged-rollout percentage. This plugin reads the same upstream feed and compares versions only. The percentage is shown and then ignored.

Choose **Every launch**, **Once a day**, or **Only when asked**. A newer build asks for confirmation. **Update** downloads that installer, checks its SHA-512 and Authenticode signature, and starts it only after DeepSeek Harness has fully quit. Use the tray icon's **Quit**. Closing the window leaves the app running, and the installer cannot replace the directory.

The `dsh_update_check` tool can report whether a newer build exists. It cannot download or install.
