// client.js — settings row and confirmation for dsh-update-checker.
// The row sits directly under the desktop update channel. It is registered only as a
// General item; it draws nothing unless the desktop development channel is selected.
// Styles use theme tokens and live inside the component, so unmounting removes them.

window.__ModuleLoader__.load({
  id: 'dsh-update-checker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const PACKAGE = 'dsh-update-checker'
    const ENDPOINTS = [
      'status', 'check', 'setCadence', 'dismiss', 'later', 'ask', 'update',
      'alphaStatus', 'alphaCheck', 'alphaConfig', 'alphaStart', 'alphaAsk', 'alphaLater', 'alphaDismiss', 'alphaConsume',
    ]

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function fill(text, values) {
      return String(text).replace(/\{([A-Za-z0-9_]+)\}/gu, (_match, key) => {
        const value = values?.[key]
        return value === undefined || value === null ? '' : String(value)
      })
    }

    function formatBytes(size) {
      if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
      const megabytes = size / (1024 * 1024)
      return megabytes >= 100 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`
    }

    function formatWhen(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return iso
      return new Date(time).toLocaleString()
    }

    function argsCodec(pkg) {
      return () => ({
        mode: 'strict',
        typeSymbol: pkg + '/typert#EndpointArgs',
        create: () => ({
          parse(value) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new TypeError(pkg + ': endpoint args must be a plain object')
            }
            return value
          },
        }),
      })
    }

    function descriptorsFor(pkg, endpoints) {
      const codec = argsCodec(pkg)
      return endpoints.map((name) => ({
        id: pkg + '#' + pkg + '/' + name,
        service: pkg,
        namespace: pkg,
        method: name,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'args', wire: 'args', source: 'json', codec: codec() }],
        result: { mode: 'src-json' },
      }))
    }

    function unwrapRemoteResult(result) {
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return result
      if (result.ok === true && 'value' in result) return result.value
      if (result.ok === false && result.error && typeof result.error === 'object') {
        const failure = result.error
        const error = new Error(failure.message || failure.code || 'remote call failed')
        error.code = failure.code
        throw error
      }
      return result
    }

    const EN = {
      title: 'Check for updates',
      description: 'Reads the newest installer from the upstream feed, including a build still in staged rollout. Current version: {version}.',
      cadenceLabel: 'Automatic check',
      cadenceLaunch: 'Every launch',
      cadenceDaily: 'Once a day',
      cadenceOff: 'Only when asked',
      check: 'Check for updates',
      checking: 'Checking…',
      update: 'Update',
      updating: 'Preparing…',
      current: 'You already have the newest upstream build.',
      available: 'Upstream {version} is newer{size}.',
      availableStaged: 'Upstream {version} is newer{size}. Staged rollout is {percent}% and is ignored here.',
      skipped: 'Version {version} was skipped. You can still update.',
      progress: 'Downloading {percent}',
      verifying: 'Checking the download…',
      armed: 'Verified. Quit the app from the tray icon to install.',
      armedTitle: 'Quit to finish the update',
      armedBody: 'The installer matches the upstream feed. Right-click the DeepSeek Harness tray icon and choose Quit. Closing the window leaves the app running, and the install cannot replace it. After you quit, installation continues and the app reopens. If you do not quit within 30 minutes, this install is cancelled.',
      later: 'Not now',
      skip: 'Skip this version',
      ack: 'Got it',
      confirmTitle: 'Update to {version}?',
      confirmBody: 'This install is {current}. Upstream has published {version}{size}. Staged rollout does not apply to this check. The download is verified before anything is installed, and installation starts only after you quit the app.',
      confirmBodyStaged: 'This install is {current}. Upstream has published {version}{size}. The feed is staged to {percent}% of installs; this check offers it anyway. The download is verified before anything is installed, and installation starts only after you quit the app.',
      checkedAt: 'Last checked {at}',
      release: 'Published {at}',
      errorRemote: 'The update check is not available right now.',
      errorFeed: 'The upstream feed could not be read.',
      errorParse: 'The upstream feed could not be understood.',
      errorDownload: 'The installer could not be downloaded.',
      errorHash: 'The download does not match the upstream feed. It was discarded.',
      errorSignature: 'The installer signature could not be verified. It was discarded.',
      errorInstall: 'The installer could not be started.',
      errorBusy: 'That update is no longer current. Check again.',
      errorConfig: 'The setting could not be saved.',
      errorGeneric: 'The update check failed.',
      alphaTitle: 'Alpha build monitoring',
      alphaDescription: 'Reads the upstream GitHub tags, clones the newest alpha source into the configured directory, then opens a new session with a build prompt. The session configures the toolchain, packages the installer, and signs it; this plugin only prepares the source.',
      alphaEnable: 'Enable alpha monitoring',
      alphaChecking: 'Reading upstream tags…',
      alphaCurrent: 'The installed build already matches the newest alpha tag.',
      alphaAvailable: 'Upstream alpha {version} is newer.',
      alphaCloning: 'Preparing the source ({step})…',
      alphaStepClone: 'cloning',
      alphaStepFetch: 'fetching tags',
      alphaStepCheckout: 'checking out the tag',
      alphaStepSubmodules: 'updating submodules',
      alphaReady: 'Source ready. Opening a session with the build prompt…',
      alphaHanded: 'The build prompt was placed in a new session. Follow the build there, then install the installer it reports.',
      alphaDisabled: 'Alpha monitoring is off.',
      alphaPath: 'Source directory',
      alphaPathPlaceholder: 'Absolute path for the deepseek-harness checkout',
      alphaChoose: 'Choose folder',
      alphaKeepSource: 'Keep the source after install (later updates fetch with git)',
      alphaDeleteHint: 'Without it, the checkout is cleaned with git and removed once the installed version matches.',
      alphaCheck: 'Check alpha tags',
      alphaUpdate: 'Build alpha {version}',
      alphaAdvanced: 'Toolchain and signing settings',
      alphaAdvancedHide: 'Hide toolchain and signing settings',
      alphaNodePath: 'Node executable',
      alphaRegistry: 'npm registry',
      alphaCertificate: 'Certificate file',
      alphaSignTool: 'signtool',
      alphaKeyContainer: 'Key container',
      alphaSignatureCacheDir: 'Signature cache',
      alphaDeleteInstaller: 'Delete the downloaded installer after install',
      alphaCheckedAt: 'Last checked {at}',
      alphaLatest: 'Upstream tag {tag}',
      alphaConfirmTitle: 'Build alpha {version}?',
      alphaConfirmBody: 'Installed: {current}. The plugin clones {tag} into {path}, registers it as a workspace, and opens a new session with the build prompt. The session follows the repository\'s own instructions to set up the toolchain, package and sign the installer. You install it manually afterwards.',
      alphaStart: 'Clone and open session',
      alphaNoPath: 'Set the source directory first.',
      alphaSessionError: 'Could not open the build session automatically. Open the workspace manually and paste the prompt.',
      alphaGit: 'git is not available on PATH.',
      alphaPathError: 'The source directory is not usable. Choose an empty folder or the existing deepseek-harness checkout.',
      alphaClone: 'Cloning the upstream repository failed.',
      alphaSync: 'Updating the source checkout failed.',
      alphaCleanup: 'Removing the source checkout failed.',
      alphaError: 'The alpha check failed.',
      alphaSkipped: 'Version {version} was skipped. You can still build it.',
    }
    const ZH = {
      title: '检查更新',
      description: '直接从上游安装源读取最新安装包，灰度发布中的版本也会提供。当前版本：{version}。',
      cadenceLabel: '自动检查',
      cadenceLaunch: '每次启动',
      cadenceDaily: '每天一次',
      cadenceOff: '仅手动',
      check: '检查更新',
      checking: '正在检查…',
      update: '更新',
      updating: '正在准备…',
      current: '已经是上游最新版本。',
      available: '上游的 {version} 更新{size}。',
      availableStaged: '上游的 {version} 更新{size}。灰度比例是 {percent}%，这里会忽略它。',
      skipped: '已跳过 {version}，仍可以更新。',
      progress: '正在下载 {percent}',
      verifying: '正在校验安装包…',
      armed: '已校验。请从托盘图标退出应用以完成安装。',
      armedTitle: '退出后完成更新',
      armedBody: '安装包已与上游安装源核对一致。请右键托盘中的 DeepSeek Harness，选择「退出」。只关窗口的话应用仍在运行，安装程序无法替换它。退出之后会继续安装并重新打开。如果 30 分钟内没有退出，这次安装会取消。',
      later: '稍后',
      skip: '跳过此版本',
      ack: '知道了',
      confirmTitle: '更新到 {version}？',
      confirmBody: '当前安装的是 {current}。上游已发布 {version}{size}。这次检查不受灰度比例影响。安装包会先校验，并且只有在你退出应用之后才会安装。',
      confirmBodyStaged: '当前安装的是 {current}。上游已发布 {version}{size}。安装源正在向 {percent}% 的安装灰度发布；这次检查仍会提供它。安装包会先校验，并且只有在你退出应用之后才会安装。',
      checkedAt: '上次检查 {at}',
      release: '发布于 {at}',
      errorRemote: '现在无法检查更新。',
      errorFeed: '读不到上游安装源。',
      errorParse: '无法识别上游安装源。',
      errorDownload: '安装包没有下载完成。',
      errorHash: '下载内容与上游安装源不一致，已丢弃。',
      errorSignature: '无法确认安装包签名，已丢弃。',
      errorInstall: '无法启动安装程序。',
      errorBusy: '这个更新已经变化，请重新检查。',
      errorConfig: '没能保存这个设置。',
      errorGeneric: '检查更新失败。',
      alphaTitle: 'Alpha 版本监测',
      alphaDescription: '读取上游 GitHub 标签，把最新的 alpha 源码克隆到指定目录，然后新建会话并填入构建提示词。工具链、打包和签名由该会话按仓库说明完成；插件只准备源码。',
      alphaEnable: '开启 Alpha 监测',
      alphaChecking: '正在读取上游标签…',
      alphaCurrent: '当前安装的版本已经是最新 alpha 标签。',
      alphaAvailable: '上游 alpha {version} 更新。',
      alphaCloning: '正在准备源码（{step}）…',
      alphaStepClone: '克隆',
      alphaStepFetch: '拉取标签',
      alphaStepCheckout: '检出标签',
      alphaStepSubmodules: '更新子模块',
      alphaReady: '源码已就绪，正在新建会话并填入构建提示词…',
      alphaHanded: '构建提示词已填入新会话。请在该会话里完成构建，然后安装它给出的安装包。',
      alphaDisabled: 'Alpha 监测未开启。',
      alphaPath: '源码目录',
      alphaPathPlaceholder: 'deepseek-harness 检出的绝对路径',
      alphaChoose: '选择文件夹',
      alphaKeepSource: '安装后保留源码（后续更新直接用 git 拉取）',
      alphaDeleteHint: '不保留时，安装版本与源码一致后会用 git 清理并删除该源码目录。',
      alphaCheck: '检查 alpha 标签',
      alphaUpdate: '构建 alpha {version}',
      alphaAdvanced: '工具链与签名设置',
      alphaAdvancedHide: '收起工具链与签名设置',
      alphaNodePath: 'Node 可执行文件',
      alphaRegistry: 'npm registry',
      alphaCertificate: '证书文件',
      alphaSignTool: 'signtool',
      alphaKeyContainer: '证书容器',
      alphaSignatureCacheDir: '签名缓存目录',
      alphaDeleteInstaller: '安装完成后删除已下载的安装包',
      alphaCheckedAt: '上次检查 {at}',
      alphaLatest: '上游标签 {tag}',
      alphaConfirmTitle: '构建 alpha {version}？',
      alphaConfirmBody: '当前安装的是 {current}。插件会把 {tag} 克隆到 {path}，登记为工作区，并新建会话填入构建提示词。工具链配置、打包和签名由该会话按仓库说明完成，安装包需要你之后手动安装。',
      alphaStart: '克隆并新建会话',
      alphaNoPath: '请先设置源码目录。',
      alphaSessionError: '无法自动打开构建会话，请手动打开工作区并粘贴提示词。',
      alphaGit: 'PATH 里找不到 git。',
      alphaPathError: '源码目录不可用。请选择空文件夹或已有的 deepseek-harness 检出。',
      alphaClone: '克隆上游仓库失败。',
      alphaSync: '更新源码失败。',
      alphaCleanup: '清理源码目录失败。',
      alphaError: 'alpha 检查失败。',
      alphaSkipped: '已跳过 {version}，仍可以构建。',
    }
    const JA = {
      title: '更新を確認',
      description: '段階的な公開中のビルドも含め、上流の配布元から最新のインストーラーを読みます。現在のバージョン: {version}。',
      cadenceLabel: '自動確認',
      cadenceLaunch: '起動ごと',
      cadenceDaily: '1日1回',
      cadenceOff: '手動のみ',
      check: '更新を確認',
      checking: '確認しています…',
      update: '更新',
      updating: '準備しています…',
      current: 'すでに上流の最新ビルドです。',
      available: '上流の {version} の方が新しいです{size}。',
      availableStaged: '上流の {version} の方が新しいです{size}。段階的公開は {percent}% ですが、ここでは無視します。',
      skipped: '{version} はスキップしました。まだ更新できます。',
      progress: 'ダウンロード中 {percent}',
      verifying: 'ダウンロードを確認しています…',
      armed: '検証済みです。トレイアイコンからアプリを終了するとインストールします。',
      armedTitle: '終了して更新を完了',
      armedBody: 'インストーラーは上流の配布元と一致しています。トレイの DeepSeek Harness を右クリックして「終了」を選んでください。ウィンドウを閉じただけではアプリは動いたままなので、置き換えできません。終了後にインストールが進み、アプリが開き直します。30分以内に終了しない場合、このインストールは取り消されます。',
      later: '後で',
      skip: 'このバージョンをスキップ',
      ack: '了解',
      confirmTitle: '{version} に更新しますか？',
      confirmBody: '現在のインストールは {current} です。上流は {version}{size} を公開しています。段階的公開はこの確認には適用されません。インストール前に検証し、アプリを終了したあとでインストールが始まります。',
      confirmBodyStaged: '現在のインストールは {current} です。上流は {version}{size} を公開しています。配布元はインストールの {percent}% に段階公開中ですが、この確認では提供します。インストール前に検証し、アプリを終了したあとでインストールが始まります。',
      checkedAt: '最終確認 {at}',
      release: '公開 {at}',
      errorRemote: '現在、更新を確認できません。',
      errorFeed: '上流の配布元を読み取れませんでした。',
      errorParse: '上流の配布元を解釈できませんでした。',
      errorDownload: 'インストーラーをダウンロードできませんでした。',
      errorHash: 'ダウンロードが上流の配布元と一致しないため、破棄しました。',
      errorSignature: 'インストーラーの署名を確認できなかったため、破棄しました。',
      errorInstall: 'インストーラーを開始できませんでした。',
      errorBusy: 'その更新は最新ではありません。もう一度確認してください。',
      errorConfig: '設定を保存できませんでした。',
      errorGeneric: '更新の確認に失敗しました。',
    }
    const DE = {
      title: 'Nach Updates suchen',
      description: 'Liest das neueste Installationsprogramm direkt aus der Upstream-Quelle, auch während einer gestaffelten Veröffentlichung. Aktuelle Version: {version}.',
      cadenceLabel: 'Automatische Prüfung',
      cadenceLaunch: 'Bei jedem Start',
      cadenceDaily: 'Einmal täglich',
      cadenceOff: 'Nur auf Abruf',
      check: 'Nach Updates suchen',
      checking: 'Wird geprüft…',
      update: 'Aktualisieren',
      updating: 'Wird vorbereitet…',
      current: 'Du hast bereits den neuesten Upstream-Build.',
      available: 'Upstream-{version} ist neuer{size}.',
      availableStaged: 'Upstream-{version} ist neuer{size}. Die gestaffelte Veröffentlichung liegt bei {percent}% und wird hier ignoriert.',
      skipped: 'Version {version} wurde übersprungen. Du kannst trotzdem aktualisieren.',
      progress: 'Wird heruntergeladen {percent}',
      verifying: 'Download wird geprüft…',
      armed: 'Geprüft. Beende die App über das Infobereichssymbol, um zu installieren.',
      armedTitle: 'Beenden, um die Aktualisierung abzuschließen',
      armedBody: 'Das Installationsprogramm stimmt mit der Upstream-Quelle überein. Klicke das DeepSeek-Harness-Symbol im Infobereich mit der rechten Maustaste und wähle Beenden. Das Fenster zu schließen lässt die App weiterlaufen, sodass sie nicht ersetzt werden kann. Nach dem Beenden wird installiert und die App neu geöffnet. Ohne Beenden innerhalb von 30 Minuten wird diese Installation abgebrochen.',
      later: 'Später',
      skip: 'Diese Version überspringen',
      ack: 'Verstanden',
      confirmTitle: 'Auf {version} aktualisieren?',
      confirmBody: 'Installiert ist {current}. Upstream hat {version}{size} veröffentlicht. Die gestaffelte Veröffentlichung gilt für diese Prüfung nicht. Der Download wird vor der Installation geprüft, und die Installation beginnt erst, nachdem du die App beendet hast.',
      confirmBodyStaged: 'Installiert ist {current}. Upstream hat {version}{size} veröffentlicht. Die Quelle staffelt die Veröffentlichung auf {percent}% der Installationen; diese Prüfung bietet sie trotzdem an. Der Download wird vor der Installation geprüft, und die Installation beginnt erst, nachdem du die App beendet hast.',
      checkedAt: 'Zuletzt geprüft {at}',
      release: 'Veröffentlicht {at}',
      errorRemote: 'Die Update-Prüfung ist gerade nicht verfügbar.',
      errorFeed: 'Die Upstream-Quelle konnte nicht gelesen werden.',
      errorParse: 'Die Upstream-Quelle konnte nicht gelesen werden.',
      errorDownload: 'Das Installationsprogramm konnte nicht heruntergeladen werden.',
      errorHash: 'Der Download stimmt nicht mit der Upstream-Quelle überein und wurde verworfen.',
      errorSignature: 'Die Signatur des Installationsprogramms konnte nicht geprüft werden. Es wurde verworfen.',
      errorInstall: 'Das Installationsprogramm konnte nicht gestartet werden.',
      errorBusy: 'Dieses Update ist nicht mehr aktuell. Prüfe erneut.',
      errorConfig: 'Die Einstellung konnte nicht gespeichert werden.',
      errorGeneric: 'Die Update-Prüfung ist fehlgeschlagen.',
    }
    const ES = {
      title: 'Buscar actualizaciones',
      description: 'Lee el instalador más reciente de la fuente original, también si la versión sigue en un lanzamiento gradual. Versión actual: {version}.',
      cadenceLabel: 'Comprobación automática',
      cadenceLaunch: 'En cada inicio',
      cadenceDaily: 'Una vez al día',
      cadenceOff: 'Solo manual',
      check: 'Buscar actualizaciones',
      checking: 'Comprobando…',
      update: 'Actualizar',
      updating: 'Preparando…',
      current: 'Ya tienes la versión más reciente de la fuente original.',
      available: 'La versión {version} de la fuente original es más nueva{size}.',
      availableStaged: 'La versión {version} de la fuente original es más nueva{size}. El lanzamiento gradual es del {percent}% y aquí se ignora.',
      skipped: 'Se omitió la versión {version}. Aún puedes actualizar.',
      progress: 'Descargando {percent}',
      verifying: 'Comprobando la descarga…',
      armed: 'Verificado. Sal de la aplicación desde el icono de la bandeja para instalar.',
      armedTitle: 'Sal para terminar la actualización',
      armedBody: 'El instalador coincide con la fuente original. Haz clic derecho en el icono de DeepSeek Harness de la bandeja y elige Salir. Cerrar la ventana deja la aplicación en ejecución y no se puede sustituir. Después de salir, la instalación continúa y la aplicación se vuelve a abrir. Si no sales en 30 minutos, esta instalación se cancela.',
      later: 'Ahora no',
      skip: 'Omitir esta versión',
      ack: 'Entendido',
      confirmTitle: '¿Actualizar a {version}?',
      confirmBody: 'Esta instalación es {current}. La fuente original ha publicado {version}{size}. El lanzamiento gradual no se aplica a esta comprobación. La descarga se verifica antes de instalar, y la instalación empieza solo después de que salgas de la aplicación.',
      confirmBodyStaged: 'Esta instalación es {current}. La fuente original ha publicado {version}{size}. La fuente lo publica de forma gradual para el {percent}% de las instalaciones; esta comprobación lo ofrece igualmente. La descarga se verifica antes de instalar, y la instalación empieza solo después de que salgas de la aplicación.',
      checkedAt: 'Última comprobación {at}',
      release: 'Publicado {at}',
      errorRemote: 'La comprobación de actualizaciones no está disponible ahora.',
      errorFeed: 'No se pudo leer la fuente original.',
      errorParse: 'No se pudo interpretar la fuente original.',
      errorDownload: 'No se pudo descargar el instalador.',
      errorHash: 'La descarga no coincide con la fuente original y se descartó.',
      errorSignature: 'No se pudo verificar la firma del instalador y se descartó.',
      errorInstall: 'No se pudo iniciar el instalador.',
      errorBusy: 'Esa actualización ya no está vigente. Comprueba de nuevo.',
      errorConfig: 'No se pudo guardar el ajuste.',
      errorGeneric: 'La comprobación de actualizaciones falló.',
    }
    const FR = {
      title: 'Rechercher des mises à jour',
      description: 'Lit le dernier installateur depuis la source amont, y compris une version encore en déploiement progressif. Version actuelle : {version}.',
      cadenceLabel: 'Vérification automatique',
      cadenceLaunch: 'À chaque lancement',
      cadenceDaily: 'Une fois par jour',
      cadenceOff: 'Uniquement sur demande',
      check: 'Rechercher des mises à jour',
      checking: 'Vérification…',
      update: 'Mettre à jour',
      updating: 'Préparation…',
      current: 'Vous avez déjà la dernière version amont.',
      available: 'La version amont {version} est plus récente{size}.',
      availableStaged: 'La version amont {version} est plus récente{size}. Le déploiement progressif est de {percent} % et il est ignoré ici.',
      skipped: 'La version {version} a été ignorée. Vous pouvez encore mettre à jour.',
      progress: 'Téléchargement {percent}',
      verifying: 'Vérification du téléchargement…',
      armed: 'Vérifié. Quittez l’application depuis l’icône de la barre pour installer.',
      armedTitle: 'Quittez pour terminer la mise à jour',
      armedBody: 'L’installateur correspond à la source amont. Faites un clic droit sur l’icône DeepSeek Harness dans la barre, puis choisissez Quitter. Fermer la fenêtre laisse l’application active, qui ne peut alors pas être remplacée. Après la fermeture, l’installation continue et l’application se rouvre. Sans fermeture sous 30 minutes, cette installation est annulée.',
      later: 'Plus tard',
      skip: 'Ignorer cette version',
      ack: 'Compris',
      confirmTitle: 'Mettre à jour vers {version} ?',
      confirmBody: 'Cette installation est {current}. La source amont a publié {version}{size}. Le déploiement progressif ne s’applique pas à cette vérification. Le téléchargement est vérifié avant toute installation, qui ne commence qu’après avoir quitté l’application.',
      confirmBodyStaged: 'Cette installation est {current}. La source amont a publié {version}{size}. La source le déploie progressivement pour {percent} % des installations ; cette vérification le propose quand même. Le téléchargement est vérifié avant toute installation, qui ne commence qu’après avoir quitté l’application.',
      checkedAt: 'Dernière vérification {at}',
      release: 'Publié {at}',
      errorRemote: 'La recherche de mise à jour est indisponible pour le moment.',
      errorFeed: 'Impossible de lire la source amont.',
      errorParse: 'Impossible d’interpréter la source amont.',
      errorDownload: 'Impossible de télécharger l’installateur.',
      errorHash: 'Le téléchargement ne correspond pas à la source amont. Il a été écarté.',
      errorSignature: 'Impossible de vérifier la signature de l’installateur. Il a été écarté.',
      errorInstall: 'Impossible de lancer l’installateur.',
      errorBusy: 'Cette mise à jour n’est plus d’actualité. Vérifiez à nouveau.',
      errorConfig: 'Impossible d’enregistrer le réglage.',
      errorGeneric: 'La recherche de mise à jour a échoué.',
    }
    const PT = {
      title: 'Procurar atualizações',
      description: 'Lê o instalador mais recente da origem upstream, inclusive uma versão ainda em lançamento gradual. Versão atual: {version}.',
      cadenceLabel: 'Verificação automática',
      cadenceLaunch: 'A cada abertura',
      cadenceDaily: 'Uma vez por dia',
      cadenceOff: 'Somente manual',
      check: 'Procurar atualizações',
      checking: 'Verificando…',
      update: 'Atualizar',
      updating: 'Preparando…',
      current: 'Você já tem a versão mais recente da origem.',
      available: 'A versão {version} da origem é mais nova{size}.',
      availableStaged: 'A versão {version} da origem é mais nova{size}. O lançamento gradual está em {percent}% e é ignorado aqui.',
      skipped: 'A versão {version} foi ignorada. Você ainda pode atualizar.',
      progress: 'Baixando {percent}',
      verifying: 'Verificando o download…',
      armed: 'Verificado. Saia do aplicativo pelo ícone da bandeja para instalar.',
      armedTitle: 'Saia para concluir a atualização',
      armedBody: 'O instalador confere com a origem upstream. Clique com o botão direito no ícone do DeepSeek Harness na bandeja e escolha Sair. Fechar a janela deixa o aplicativo em execução, e ele não pode ser substituído. Depois que você sair, a instalação continua e o aplicativo reabre. Se você não sair em 30 minutos, esta instalação é cancelada.',
      later: 'Agora não',
      skip: 'Ignorar esta versão',
      ack: 'Entendi',
      confirmTitle: 'Atualizar para {version}?',
      confirmBody: 'Esta instalação é {current}. A origem publicou {version}{size}. O lançamento gradual não se aplica a esta verificação. O download é verificado antes da instalação, que só começa depois que você sair do aplicativo.',
      confirmBodyStaged: 'Esta instalação é {current}. A origem publicou {version}{size}. A origem está em lançamento gradual para {percent}% das instalações; esta verificação oferece a versão mesmo assim. O download é verificado antes da instalação, que só começa depois que você sair do aplicativo.',
      checkedAt: 'Última verificação {at}',
      release: 'Publicado {at}',
      errorRemote: 'A verificação de atualização não está disponível agora.',
      errorFeed: 'Não foi possível ler a origem upstream.',
      errorParse: 'Não foi possível interpretar a origem upstream.',
      errorDownload: 'Não foi possível baixar o instalador.',
      errorHash: 'O download não confere com a origem upstream e foi descartado.',
      errorSignature: 'Não foi possível verificar a assinatura do instalador. Ele foi descartado.',
      errorInstall: 'Não foi possível iniciar o instalador.',
      errorBusy: 'Essa atualização não está mais vigente. Verifique de novo.',
      errorConfig: 'Não foi possível salvar a configuração.',
      errorGeneric: 'A verificação de atualização falhou.',
    }
    const RU = {
      title: 'Проверить обновления',
      description: 'Читает новый установщик прямо из исходного канала, в том числе сборку в поэтапной публикации. Текущая версия: {version}.',
      cadenceLabel: 'Автоматическая проверка',
      cadenceLaunch: 'При каждом запуске',
      cadenceDaily: 'Раз в день',
      cadenceOff: 'Только вручную',
      check: 'Проверить обновления',
      checking: 'Проверка…',
      update: 'Обновить',
      updating: 'Подготовка…',
      current: 'Уже установлена последняя сборка из исходного канала.',
      available: 'Сборка {version} новее{size}.',
      availableStaged: 'Сборка {version} новее{size}. Поэтапная публикация охватывает {percent}%, здесь она не учитывается.',
      skipped: 'Версия {version} пропущена. Обновление всё ещё можно установить.',
      progress: 'Загрузка {percent}',
      verifying: 'Проверка загрузки…',
      armed: 'Проверено. Выйдите из приложения через значок в области уведомлений, чтобы установить.',
      armedTitle: 'Выйдите, чтобы завершить обновление',
      armedBody: 'Установщик совпадает с исходным каналом. Щёлкните правой кнопкой значок DeepSeek Harness в области уведомлений и выберите «Выход». Закрытие окна оставляет приложение запущенным, и заменить его нельзя. После выхода установка продолжится, и приложение откроется снова. Если не выйти в течение 30 минут, эта установка отменяется.',
      later: 'Не сейчас',
      skip: 'Пропустить эту версию',
      ack: 'Понятно',
      confirmTitle: 'Обновить до {version}?',
      confirmBody: 'Сейчас установлена {current}. В исходном канале опубликована {version}{size}. Поэтапная публикация на эту проверку не влияет. Загрузка проверяется до установки, а установка начнётся только после выхода из приложения.',
      confirmBodyStaged: 'Сейчас установлена {current}. В исходном канале опубликована {version}{size}. Канал публикует её для {percent}% установок; эта проверка предлагает её в любом случае. Загрузка проверяется до установки, а установка начнётся только после выхода из приложения.',
      checkedAt: 'Последняя проверка {at}',
      release: 'Опубликовано {at}',
      errorRemote: 'Проверка обновлений сейчас недоступна.',
      errorFeed: 'Не удалось прочитать исходный канал.',
      errorParse: 'Не удалось разобрать исходный канал.',
      errorDownload: 'Не удалось загрузить установщик.',
      errorHash: 'Загрузка не совпадает с исходным каналом и удалена.',
      errorSignature: 'Не удалось проверить подпись установщика. Он удалён.',
      errorInstall: 'Не удалось запустить установщик.',
      errorBusy: 'Это обновление уже неактуально. Проверьте снова.',
      errorConfig: 'Не удалось сохранить настройку.',
      errorGeneric: 'Проверка обновления не удалась.',
    }

    const CSS = `
.duc-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.duc-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:24px;}
.duc-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary);}
.duc-description,.duc-meta{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.duc-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.duc-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}
.duc-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);}
.duc-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);}
.duc-controls{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;}
.duc-select,.duc-button{height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;}
.duc-button-primary{color:var(--dsw-alias-brand-primary);font-weight:600;}
.duc-button:disabled,.duc-select:disabled{cursor:default;color:var(--dsw-alias-label-tertiary);}
@media (hover:hover){.duc-select:hover,.duc-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}}
.duc-select:focus-visible,.duc-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.duc-card{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:40;box-sizing:border-box;width:min(440px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px;padding:16px 16px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);pointer-events:auto;box-shadow:none;}
.duc-card-title{margin:0;font-size:14px;font-weight:600;line-height:22px;}
.duc-card-body{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}
.duc-card-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;}
.duc-alpha{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.duc-alpha-head{display:flex;align-items:flex-start;gap:8px;}
.duc-alpha-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:24px;}
.duc-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.duc-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex:none;min-width:88px;}
.duc-input{flex:1;min-width:120px;height:32px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;}
.duc-input::placeholder{color:var(--dsw-alias-label-tertiary);}
.duc-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.duc-check{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.duc-check input{accent-color:var(--dsw-alias-brand-primary);}
.duc-link{align-self:flex-start;padding:0;border:none;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;}
.duc-advanced{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);}
@media (max-width:767px){.duc-row,.duc-alpha-head{align-items:flex-start;flex-wrap:wrap;}.duc-text,.duc-alpha-text{padding-right:0;}.duc-controls{width:100%;justify-content:flex-start;}.duc-label{min-width:0;}}
`

    return {
      inject: ['slots', 'locale', 'remote', 'uiWorkspace'],
      apply(ctx) {
        const disposeLocale = ctx.locale.register(PACKAGE, {
          zh: ZH, en: EN, ja: JA, de: DE, es: ES, fr: FR, pt: PT, ru: RU,
        })
        const translate = ctx.locale.bind(PACKAGE)
        const t = (key, values) => fill(translate(key, values), values)

        let snapshot = { phase: 'loading', applicable: null, latest: null, error: null, prompt: false }
        const listeners = new Set()
        const store = {
          get: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          set(next) {
            snapshot = next && typeof next === 'object' ? next : snapshot
            for (const listener of [...listeners]) listener()
          },
        }

        let mounting = null
        async function endpoint(name, args) {
          const remote = ctx.get('remote')
          if (!remote || typeof remote.$mount !== 'function') throw new Error(t('errorRemote'))
          if (mounting === null) {
            mounting = remote.$mount({ package: PACKAGE, descriptors: descriptorsFor(PACKAGE, ENDPOINTS) })
              .catch((error) => {
                mounting = null
                throw error
              })
          }
          await mounting
          const service = ctx.get('remote.' + PACKAGE) || remote[PACKAGE]
          if (!service || typeof service[name] !== 'function') throw new Error(t('errorRemote'))
          return unwrapRemoteResult(await service[name](args ?? {}))
        }

        async function refresh() {
          try {
            const next = await endpoint('status', {})
            if (next && typeof next === 'object') store.set(next)
          } catch (error) {
            store.set({ ...snapshot, phase: 'error', error: { code: 'remote', detail: describe(error) } })
          }
        }

        function errorText(error) {
          const code = error?.code
          const key = {
            remote: 'errorRemote', feed: 'errorFeed', parse: 'errorParse', download: 'errorDownload',
            hash: 'errorHash', signature: 'errorSignature', install: 'errorInstall', busy: 'errorBusy',
            config: 'errorConfig',
          }[code] ?? 'errorGeneric'
          return t(key)
        }

        function versionFacts(snap) {
          const latest = snap.latest ?? {}
          const size = formatBytes(latest.size)
          return {
            version: latest.version ?? '',
            current: snap.currentVersion ?? '',
            percent: latest.stagingPercentage ?? '',
            size: size === '' ? '' : ` (${size})`,
            at: formatWhen(latest.releaseDate),
          }
        }

        function UpdateRow() {
          const snap = useSyncExternalStore(store.subscribe, store.get)
          if (snap.applicable !== true) return null
          const facts = versionFacts(snap)
          const busy = snap.phase === 'checking' || snap.phase === 'downloading' || snap.phase === 'verifying'
          const newer = snap.phase === 'available' || snap.phase === 'armed' || snap.phase === 'downloading' || snap.phase === 'verifying'
          const skipped = snap.dismissedVersion && snap.latest?.version === snap.dismissedVersion
          let status = null
          let tone = 'duc-status'
          if (snap.phase === 'checking') status = t('checking')
          else if (snap.phase === 'downloading') {
            const percent = snap.progress?.percent
            status = t('progress', { percent: typeof percent === 'number' ? `${percent}%` : '…' })
          } else if (snap.phase === 'verifying') status = t('verifying')
          else if (snap.phase === 'armed') {
            status = t('armed')
            tone = 'duc-warn'
          } else if (snap.phase === 'current') {
            status = t('current')
            tone = 'duc-ok'
          } else if (snap.phase === 'available') {
            const staged = typeof snap.latest?.stagingPercentage === 'number'
            status = t(staged ? 'availableStaged' : 'available', facts)
            if (skipped) status = `${status} ${t('skipped', facts)}`
          } else if (snap.phase === 'error' && snap.error) {
            status = errorText(snap.error)
            tone = 'duc-error'
          }
          const meta = [
            snap.checkedAt ? t('checkedAt', { at: formatWhen(snap.checkedAt) }) : '',
            facts.at ? t('release', facts) : '',
          ].filter(Boolean).join(' · ')
          return h('div', { className: 'duc-row', role: 'group', 'aria-label': t('title') },
            h('style', null, CSS),
            h('div', { className: 'duc-text' },
              h('div', { className: 'duc-title' }, t('title')),
              h('div', { className: 'duc-description' }, t('description', { version: snap.currentVersion ?? '…' })),
              status ? h('div', { className: tone, role: 'status', 'aria-live': 'polite' }, status) : null,
              meta ? h('div', { className: 'duc-meta' }, meta) : null),
            h('div', { className: 'duc-controls' },
              h('select', {
                className: 'duc-select',
                'aria-label': t('cadenceLabel'),
                value: snap.cadence === 'daily' || snap.cadence === 'off' ? snap.cadence : 'launch',
                disabled: busy,
                onChange: (event) => {
                  void endpoint('setCadence', { cadence: event.target.value }).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch((error) => {
                    store.set({ ...snap, error: { code: 'config', detail: describe(error) } })
                  })
                },
              },
                h('option', { value: 'launch' }, t('cadenceLaunch')),
                h('option', { value: 'daily' }, t('cadenceDaily')),
                h('option', { value: 'off' }, t('cadenceOff'))),
              h('button', {
                type: 'button', className: 'duc-button', disabled: busy,
                onClick: () => {
                  void endpoint('check', { manual: true }).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch((error) => {
                    store.set({ ...snap, phase: 'error', error: { code: 'remote', detail: describe(error) } })
                  })
                },
              }, snap.phase === 'checking' ? t('checking') : t('check')),
              newer && snap.latest?.version ? h('button', {
                type: 'button', className: 'duc-button duc-button-primary', disabled: busy || snap.phase === 'armed',
                onClick: () => {
                  void endpoint('ask', {}).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch((error) => {
                    store.set({ ...snap, phase: 'error', attention: true, error: { code: 'remote', detail: describe(error) } })
                  })
                },
              }, busy ? t('updating') : t('update')) : null))
        }

        function UpdatePrompt() {
          const snap = useSyncExternalStore(store.subscribe, store.get)
          const [armHidden, setArmHidden] = useState(false)
          const primary = useRef(null)
          const armed = snap.phase === 'armed' && armHidden !== true
          const working = snap.phase === 'downloading' || snap.phase === 'verifying'
          const failed = snap.attention === true && snap.error && !working
          const confirming = snap.applicable === true && snap.prompt === true && snap.latest?.version && !armed && !failed
          const open = snap.applicable === true && (confirming || working || armed || failed)
          useEffect(() => {
            if (snap.phase !== 'armed') setArmHidden(false)
          }, [snap.phase])
          useEffect(() => {
            if (!open) return undefined
            primary.current?.focus()
            const onKey = (event) => {
              if (event.key !== 'Escape' || working) return
              event.preventDefault()
              if (armed) setArmHidden(true)
              else if (failed) {
                void endpoint('later', {}).then((next) => {
                  if (next && typeof next === 'object') store.set(next)
                }).catch(() => {})
              } else {
                void endpoint('later', {}).then((next) => {
                  if (next && typeof next === 'object') store.set(next)
                }).catch(() => {})
              }
            }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [open, armed, working, failed])
          if (!open) return null
          const facts = versionFacts(snap)
          const staged = typeof snap.latest?.stagingPercentage === 'number'
          const title = armed ? t('armedTitle') : failed ? errorText(snap.error) : working ? (snap.phase === 'verifying' ? t('verifying') : t('progress', {
            percent: typeof snap.progress?.percent === 'number' ? `${snap.progress.percent}%` : '…',
          })) : t('confirmTitle', facts)
          const body = failed ? '' : armed ? t('armedBody') : working ? t('confirmBody', facts) : t(staged ? 'confirmBodyStaged' : 'confirmBody', facts)
          const failure = !failed && snap.error ? h('p', { className: 'duc-error', role: 'alert' }, errorText(snap.error)) : null
          return h('div', { className: 'duc-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'duc-update-title' },
            h('style', null, CSS),
            h('h2', { className: 'duc-card-title', id: 'duc-update-title' }, title),
            body ? h('p', { className: 'duc-card-body' }, body) : null,
            failure,
            h('div', { className: 'duc-card-actions' },
              armed || failed ? h('button', {
                type: 'button', className: 'duc-button duc-button-primary', ref: primary,
                onClick: () => {
                  if (armed) setArmHidden(true)
                  else {
                    void endpoint('later', {}).then((next) => {
                      if (next && typeof next === 'object') store.set(next)
                    }).catch(() => {})
                  }
                },
              }, t('ack')) : null,
              confirming ? h('button', {
                type: 'button', className: 'duc-button',
                onClick: () => {
                  void endpoint('later', {}).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch(() => {})
                },
              }, t('later')) : null,
              confirming ? h('button', {
                type: 'button', className: 'duc-button',
                onClick: () => {
                  void endpoint('dismiss', { version: snap.latest.version }).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch(() => {})
                },
              }, t('skip')) : null,
              confirming ? h('button', {
                type: 'button', className: 'duc-button duc-button-primary', ref: primary,
                onClick: () => {
                  void endpoint('update', { version: snap.latest.version }).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch((error) => {
                    store.set({ ...snap, phase: 'error', prompt: false, attention: true, error: { code: 'remote', detail: describe(error) } })
                  })
                },
              }, t('update')) : null))
        }

        function alphaFacts(alpha) {
          return {
            version: alpha?.latest?.version ?? '',
            tag: alpha?.latest?.tag ?? alpha?.latest?.version ?? '',
            current: alpha?.currentVersion ?? '',
            path: alpha?.path ?? '',
            at: formatWhen(alpha?.checkedAt),
          }
        }

        function alphaErrorText(error) {
          const key = {
            remote: 'errorRemote', git: 'alphaGit', path: 'alphaPathError', clone: 'alphaClone',
            sync: 'alphaSync', cleanup: 'alphaCleanup', alpha: 'alphaError', busy: 'errorBusy',
            config: 'errorConfig',
          }[error?.code] ?? 'errorGeneric'
          return t(key)
        }

        function alphaStatus(alpha) {
          if (!alpha) return null
          switch (alpha.phase) {
            case 'checking': return { text: t('alphaChecking'), tone: 'duc-status' }
            case 'cloning': {
              const step = {
                clone: 'alphaStepClone', fetch: 'alphaStepFetch', checkout: 'alphaStepCheckout', submodules: 'alphaStepSubmodules',
              }[alpha.progress?.step]
              return { text: t('alphaCloning', { step: step ? t(step) : '…' }), tone: 'duc-status' }
            }
            case 'ready': return { text: t('alphaReady'), tone: 'duc-warn' }
            case 'handed': return { text: t('alphaHanded'), tone: 'duc-warn' }
            case 'current': return { text: t('alphaCurrent'), tone: 'duc-ok' }
            case 'available': {
              const facts = alphaFacts(alpha)
              const skipped = alpha.dismissedVersion === alpha.latest?.version
              return { text: skipped ? `${t('alphaAvailable', facts)} ${t('alphaSkipped', facts)}` : t('alphaAvailable', facts), tone: 'duc-status' }
            }
            case 'error': return { text: alpha.error ? alphaErrorText(alpha.error) : t('alphaError'), tone: 'duc-error' }
            default: return alpha.enabled === true ? null : { text: t('alphaDisabled'), tone: 'duc-meta' }
          }
        }

        function AlphaRow() {
          const snap = useSyncExternalStore(store.subscribe, store.get)
          const alpha = snap.alpha
          const [pathDraft, setPathDraft] = useState('')
          const [advancedOpen, setAdvancedOpen] = useState(false)
          const [draft, setDraft] = useState({})
          const advancedFields = [
            ['nodePath', 'alphaNodePath'],
            ['registry', 'alphaRegistry'],
            ['certificateFile', 'alphaCertificate'],
            ['signTool', 'alphaSignTool'],
            ['keyContainer', 'alphaKeyContainer'],
            ['signatureCacheDir', 'alphaSignatureCacheDir'],
          ]
          const advancedSignature = advancedFields.map(([key]) => String(alpha?.advanced?.[key] ?? '')).join('\u0000')
          useEffect(() => {
            if (alpha?.path !== undefined) setPathDraft(alpha.path)
          }, [alpha?.path])
          useEffect(() => {
            if (alpha?.advanced !== undefined) setDraft({ ...alpha.advanced })
          }, [advancedSignature])
          if (!alpha || alpha.applicable !== true) return null
          const busy = alpha.phase === 'checking' || alpha.phase === 'cloning'
          const newer = alpha.enabled === true && alpha.phase === 'available'
          const state = alphaStatus(alpha)
          const save = (patch) => {
            void endpoint('alphaConfig', patch).then((next) => {
              if (next && typeof next === 'object') store.set(next)
            }).catch((error) => {
              const current = store.get()
              store.set({ ...current, alpha: { ...(current.alpha ?? {}), error: { code: 'remote', detail: describe(error) } } })
            })
          }
          const commitPath = () => {
            const value = pathDraft.trim()
            if (value === (alpha.path ?? '')) return
            save({ path: value })
          }
          const choose = () => {
            const ui = ctx.get('uiWorkspace')
            if (!ui || typeof ui.pickDirectory !== 'function') return
            void ui.pickDirectory().then((directory) => {
              if (typeof directory !== 'string' || directory === '') return
              setPathDraft(directory)
              if (directory !== (alpha.path ?? '')) save({ path: directory })
            }).catch(() => {})
          }
          const commitAdvanced = (key) => {
            const value = String(draft[key] ?? '').trim()
            if (value === (alpha.advanced?.[key] ?? '')) return
            save({ [key]: value })
          }
          const meta = [
            alpha.checkedAt ? t('alphaCheckedAt', { at: formatWhen(alpha.checkedAt) }) : '',
            alpha.latest?.tag ? t('alphaLatest', { tag: alpha.latest.tag }) : '',
          ].filter(Boolean).join(' · ')
          return h('div', { className: 'duc-alpha', role: 'group', 'aria-label': t('alphaTitle') },
            h('style', null, CSS),
            h('div', { className: 'duc-alpha-head' },
              h('div', { className: 'duc-alpha-text' },
                h('div', { className: 'duc-title' }, t('alphaTitle')),
                h('div', { className: 'duc-description' }, t('alphaDescription')),
                state ? h('div', { className: state.tone, role: 'status', 'aria-live': 'polite' }, state.text) : null,
                meta ? h('div', { className: 'duc-meta' }, meta) : null),
              h('div', { className: 'duc-controls' },
                h('label', { className: 'duc-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: alpha.enabled === true,
                    disabled: alpha.phase === 'cloning',
                    onChange: (event) => save({ enabled: event.target.checked }),
                  }),
                  t('alphaEnable')),
                h('button', {
                  type: 'button', className: 'duc-button', disabled: busy,
                  onClick: () => {
                    void endpoint('alphaCheck', { manual: true }).then((next) => {
                      if (next && typeof next === 'object') store.set(next)
                    }).catch((error) => {
                      const current = store.get()
                      store.set({ ...current, alpha: { ...(current.alpha ?? {}), phase: 'error', error: { code: 'remote', detail: describe(error) } } })
                    })
                  },
                }, alpha.phase === 'checking' ? t('alphaChecking') : t('alphaCheck')),
                newer && alpha.latest?.version ? h('button', {
                  type: 'button', className: 'duc-button duc-button-primary', disabled: busy,
                  onClick: () => {
                    void endpoint('alphaAsk', {}).then((next) => {
                      if (next && typeof next === 'object') store.set(next)
                    }).catch(() => {})
                  },
                }, t('alphaUpdate', { version: alpha.latest.version })) : null)),
            h('div', { className: 'duc-field' },
              h('span', { className: 'duc-label' }, t('alphaPath')),
              h('input', {
                type: 'text', className: 'duc-input', value: pathDraft,
                placeholder: t('alphaPathPlaceholder'),
                spellCheck: false,
                onChange: (event) => setPathDraft(event.target.value),
                onBlur: commitPath,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                },
              }),
              h('button', { type: 'button', className: 'duc-button', onClick: choose }, t('alphaChoose'))),
            h('label', { className: 'duc-check' },
              h('input', {
                type: 'checkbox',
                checked: alpha.keepSource === true,
                onChange: (event) => save({ keepSource: event.target.checked }),
              }),
              t('alphaKeepSource')),
            alpha.keepSource !== true && alpha.path !== '' ? h('div', { className: 'duc-meta' }, t('alphaDeleteHint')) : null,
            alpha.enabled === true && alpha.path === '' ? h('div', { className: 'duc-warn' }, t('alphaNoPath')) : null,
            h('button', {
              type: 'button', className: 'duc-link',
              onClick: () => setAdvancedOpen((open) => !open),
            }, t(advancedOpen ? 'alphaAdvancedHide' : 'alphaAdvanced')),
            advancedOpen ? h('div', { className: 'duc-advanced' },
              advancedFields.map(([key, labelKey]) => h('div', { className: 'duc-field', key },
                h('span', { className: 'duc-label' }, t(labelKey)),
                h('input', {
                  type: 'text', className: 'duc-input', value: draft[key] ?? '',
                  spellCheck: false,
                  onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })),
                  onBlur: () => commitAdvanced(key),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  },
                }))),
              h('label', { className: 'duc-check' },
                h('input', {
                  type: 'checkbox',
                  checked: alpha.advanced?.deleteInstaller === true,
                  onChange: (event) => save({ deleteInstaller: event.target.checked }),
                }),
                t('alphaDeleteInstaller'))
            ) : null)
        }

        function AlphaPrompt() {
          const snap = useSyncExternalStore(store.subscribe, store.get)
          const alpha = snap.alpha
          const primary = useRef(null)
          const confirming = alpha?.applicable === true && alpha.enabled === true
            && alpha.prompt === true && alpha.phase === 'available' && typeof alpha.latest?.version === 'string'
          const actionable = confirming && alpha.path !== ''
          useEffect(() => {
            if (!confirming) return undefined
            primary.current?.focus()
            const onKey = (event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              void endpoint('alphaLater', {}).then((next) => {
                if (next && typeof next === 'object') store.set(next)
              }).catch(() => {})
            }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [confirming])
          if (!confirming) return null
          const facts = alphaFacts(alpha)
          return h('div', { className: 'duc-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'duc-alpha-title' },
            h('style', null, CSS),
            h('h2', { className: 'duc-card-title', id: 'duc-alpha-title' }, t('alphaConfirmTitle', facts)),
            h('p', { className: 'duc-card-body' }, t('alphaConfirmBody', facts)),
            alpha.error ? h('p', { className: 'duc-error', role: 'alert' }, alphaErrorText(alpha.error)) : null,
            h('div', { className: 'duc-card-actions' },
              h('button', {
                type: 'button', className: 'duc-button',
                onClick: () => {
                  void endpoint('alphaLater', {}).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch(() => {})
                },
              }, t('later')),
              h('button', {
                type: 'button', className: 'duc-button',
                onClick: () => {
                  void endpoint('alphaDismiss', { version: alpha.latest.version }).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch(() => {})
                },
              }, t('skip')),
              h('button', {
                type: 'button', className: 'duc-button duc-button-primary', ref: primary, disabled: !actionable,
                onClick: () => {
                  if (!actionable) return
                  void endpoint('alphaLater', {}).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch(() => {})
                  void endpoint('alphaStart', { version: alpha.latest.version }).then((next) => {
                    if (next && typeof next === 'object') store.set(next)
                  }).catch((error) => {
                    const current = store.get()
                    store.set({ ...current, alpha: { ...(current.alpha ?? {}), phase: 'error', error: { code: 'remote', detail: describe(error) } } })
                  })
                },
              }, t('alphaStart'))))
        }

        ctx.effect(() => disposeLocale, 'dsh-update-checker: locale')
        ctx.effect(() => {
          let stopped = false
          let timer
          const tick = () => {
            void refresh().finally(() => {
              if (stopped) return
              const phase = store.get().phase
              const delay = phase === 'downloading' || phase === 'verifying' ? 400 : 5000
              timer = setTimeout(tick, delay)
            })
          }
          timer = setTimeout(tick, 600)
          return () => {
            stopped = true
            clearTimeout(timer)
          }
        }, 'dsh-update-checker: poll upstream status')

        let handoffToken = null
        let handoffBusy = false
        let handoffTimer = null
        let handoffDisposed = false
        function openBuildSession() {
          if (handoffDisposed) return
          const snap = store.get()
          const alpha = snap.alpha
          if (!alpha || alpha.phase !== 'ready') return
          if (typeof alpha.workspaceId !== 'string' || typeof alpha.promptText !== 'string' || handoffBusy) return
          const token = `${alpha.handoff?.version ?? ''}#${alpha.handoff?.at ?? ''}`
          if (handoffToken === token) return
          const workspace = ctx.get('uiWorkspace')
          if (!workspace || typeof workspace.startSession !== 'function') {
            handoffToken = token
            console.warn('dsh-update-checker: uiWorkspace.startSession is unavailable')
            return
          }
          handoffBusy = true
          const options = { prompt: alpha.promptText, whenDraftExists: 'replace' }
          const start = () => {
            try {
              workspace.startSession(alpha.workspaceId, options)
            } catch (error) {
              handoffBusy = false
              handoffToken = token
              console.warn('dsh-update-checker: could not start the build session:', describe(error))
              return
            }
            handoffToken = token
            handoffTimer = setTimeout(() => {
              void endpoint('alphaConsume', { version: alpha.handoff?.version }).then((next) => {
                if (next && typeof next === 'object') store.set(next)
              }).catch(() => {}).finally(() => {
                handoffBusy = false
              })
            }, 1500)
          }
          const attempt = (remaining) => {
            if (handoffDisposed) return
            if (typeof workspace.connectWorkspace !== 'function') {
              start()
              return
            }
            Promise.resolve(workspace.connectWorkspace(alpha.workspaceId))
              .then(() => start())
              .catch((error) => {
                if (remaining > 0) {
                  handoffTimer = setTimeout(() => attempt(remaining - 1), 900)
                  return
                }
                handoffBusy = false
                handoffToken = token
                console.warn('dsh-update-checker: could not reach the new workspace:', describe(error))
              })
          }
          attempt(4)
        }
        ctx.effect(() => {
          const unsubscribe = store.subscribe(openBuildSession)
          return () => {
            handoffDisposed = true
            if (handoffTimer !== null) clearTimeout(handoffTimer)
            unsubscribe()
          }
        }, 'dsh-update-checker: alpha handoff')

        ctx.effect(() => {
          const stops = [
            ctx.slots.inject('settings.general.item', () => ctx.slots.register({
              name: 'settings.general.item',
              id: 'upstream-update',
              order: 96,
            }, UpdateRow)),
            ctx.slots.inject('settings.general.item', () => ctx.slots.register({
              name: 'settings.general.item',
              id: 'alpha-update',
              order: 97,
            }, AlphaRow)),
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: 'upstream-update-prompt',
              order: 48,
            }, UpdatePrompt)),
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: 'alpha-update-prompt',
              order: 47,
            }, AlphaPrompt)),
          ]
          return () => {
            for (const stop of stops) stop?.()
          }
        }, 'dsh-update-checker: settings row and confirmation')
      },
    }
  },
})
