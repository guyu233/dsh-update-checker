# Upstream update check and alpha source builds

While the desktop development channel is selected, Settings → General shows **Check for updates** directly under **Update channel**.

The packaged updater hides a build when this machine falls outside the feed's staged-rollout percentage. This plugin reads the same upstream feed and compares versions only. The percentage is shown and then ignored.

Choose **Every launch**, **Once a day**, or **Only when asked**. A newer build asks for confirmation. **Update** downloads that installer, checks its SHA-512 and Authenticode signature, and starts it only after DeepSeek Harness has fully quit. Use the tray icon's **Quit**. Closing the window leaves the app running, and the installer cannot replace the directory.

The `dsh_update_check` tool can report whether a newer build exists. It cannot download or install.

## Alpha builds from source

Settings → General also shows **Alpha monitoring**. When it is on, the plugin lists `https://github.com/deepseek-ai/deepseek-harness/tags` with `git ls-remote`, picks the highest `dsh-v*` alpha tag, and compares it with the installed version. A confirmation card offers two paths:

- **Build alpha**: the plugin runs `git clone` (or `git fetch` plus a tag checkout for an existing clone) into the configured source directory, creates a DeepSeek Harness workspace for that folder and opens a new session with a build prompt. The prompt tells the session to follow the repository's own README and packaging scripts, set up the toolchain, and produce a signed installer for the requested version. The plugin never configures the toolchain or builds by itself, and it never installs the result; you install the installer manually.
- **Not now / Skip this version**: close the card, or stop asking about that version.

The source directory must be an absolute path outside the app install directory and the plugin data directory. Toolchain and signing details (`nodePath`, `registry`, `certificateFile`, `signTool`, `keyContainer`, `signatureCacheDir`) live under **Toolchain and signing settings** and are passed to the build prompt.

**Keep the source** controls what happens after the built version is installed. When it stays on, later alpha builds reuse the folder with `git fetch` and a tag checkout. When it is off, once the installed version matches the built tag, the plugin verifies the folder is a `deepseek-harness` work tree and removes it with git (`clean`, `reset --hard`, then delete).
