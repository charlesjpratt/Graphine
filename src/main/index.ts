import { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem } from 'electron'
import { join } from 'path'
import { writeFile, readFile, unlink } from 'fs/promises'
import { createHmac, timingSafeEqual, randomUUID } from 'crypto'

const HMAC_SECRET = 'graphine-integrity-v1'

type SignedDoc = Record<string, unknown> & { version?: number; hmac?: string }

// Sign the entire document (every field except hmac itself) so the replay timeline —
// which for v3 files lives in sessionRecording, not tabs — is covered.
function fullHmac(obj: SignedDoc): string {
  const { hmac: _hmac, ...rest } = obj
  void _hmac
  return createHmac('sha256', HMAC_SECRET).update(JSON.stringify(rest)).digest('hex')
}

// Earlier builds signed only obj.tabs / obj.frames. Kept so files saved by those
// builds still open; new saves always use fullHmac.
function legacyHmac(obj: SignedDoc): string {
  const payload = (obj.version === 2 || obj.version === 3) ? obj.tabs : obj.frames
  // No legacy payload to sign (hand-edited/malformed file) — return a value that
  // can never match rather than letting JSON.stringify(undefined) crash update().
  if (payload === undefined) return ''
  return createHmac('sha256', HMAC_SECRET).update(JSON.stringify(payload)).digest('hex')
}

function addHmac(json: string): string {
  const obj = JSON.parse(json) as SignedDoc
  obj.hmac = fullHmac(obj)
  return JSON.stringify(obj, null, 2)
}

function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function verifyAndStrip(json: string): string {
  const obj = JSON.parse(json) as SignedDoc
  // Legacy/unsigned files (saved before integrity signatures existed) load as-is.
  if (!obj.hmac) return json
  if (!matches(obj.hmac, fullHmac(obj)) && !matches(obj.hmac, legacyHmac(obj)))
    throw new Error('Recording integrity check failed — file may have been modified')
  delete obj.hmac
  return JSON.stringify(obj, null, 2)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 620,
    minHeight: 500,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreen', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreen', false)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('window:fullscreen', mainWindow.isFullScreen())
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  buildMenu()
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  const fileMenu = new Menu()
  fileMenu.append(new MenuItem({
    label: 'New Recording',
    accelerator: 'CmdOrCtrl+N',
    click: () => mainWindow?.webContents.send('menu:action', 'new'),
  }))
  fileMenu.append(new MenuItem({
    label: 'Save Recording…',
    accelerator: 'CmdOrCtrl+S',
    click: () => mainWindow?.webContents.send('menu:action', 'save'),
  }))
  fileMenu.append(new MenuItem({
    label: 'Export to PDF…',
    accelerator: 'CmdOrCtrl+E',
    click: () => mainWindow?.webContents.send('menu:action', 'export-pdf'),
  }))
  fileMenu.append(new MenuItem({ type: 'separator' }))
  fileMenu.append(new MenuItem({
    label: 'Open File…',
    accelerator: 'CmdOrCtrl+O',
    click: () => mainWindow?.webContents.send('menu:action', 'open'),
  }))

  const viewMenu = new Menu()
  viewMenu.append(new MenuItem({
    label: 'Write',
    accelerator: 'CmdOrCtrl+1',
    click: () => mainWindow?.webContents.send('menu:action', 'view:write'),
  }))
  viewMenu.append(new MenuItem({
    label: 'Replay',
    accelerator: 'CmdOrCtrl+2',
    click: () => mainWindow?.webContents.send('menu:action', 'view:replay'),
  }))
  viewMenu.append(new MenuItem({ type: 'separator' }))
  viewMenu.append(new MenuItem({
    label: 'Increase Font Size',
    accelerator: 'CmdOrCtrl+=',
    click: () => mainWindow?.webContents.send('menu:action', 'font:increase'),
  }))
  viewMenu.append(new MenuItem({
    label: 'Decrease Font Size',
    accelerator: 'CmdOrCtrl+-',
    click: () => mainWindow?.webContents.send('menu:action', 'font:decrease'),
  }))
  viewMenu.append(new MenuItem({ type: 'separator' }))
  viewMenu.append(new MenuItem({ role: 'toggleDevTools' }))

  const template: Electron.MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push(
    { label: 'File', submenu: fileMenu },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewMenu },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
      ],
    },
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog:save', async (_e, json: string, defaultName: string) => {
  if (!mainWindow) return null
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Recording',
    defaultPath: defaultName,
    filters: [
      { name: 'Graphine Recording', extensions: ['grph'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (canceled || !filePath) return null
  await writeFile(filePath, addHmac(json), 'utf8')
  return filePath
})

ipcMain.handle('dialog:open', async () => {
  if (!mainWindow) return null
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open File',
    filters: [
      { name: 'Graphine Recording', extensions: ['grph'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (canceled || filePaths.length === 0) return null
  const raw = await readFile(filePaths[0], 'utf8')
  const content = verifyAndStrip(raw)
  return { content, filePath: filePaths[0] }
})

ipcMain.handle('file:write', async (_e, filePath: string, json: string) => {
  await writeFile(filePath, addHmac(json), 'utf8')
})

// Render a self-contained HTML document to PDF via an offscreen window so the output
// contains only the document content (not the app chrome). The PDF is NOT signed —
// addHmac is JSON-only and would corrupt a binary file.
ipcMain.handle('dialog:export-pdf', async (_e, html: string, defaultName: string) => {
  if (!mainWindow) return null

  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  // Temp file + loadFile avoids Chromium's data:-URL length limit on large documents.
  const tmpPath = join(app.getPath('temp'), `graphine-export-${randomUUID()}.html`)

  try {
    await writeFile(tmpPath, html, 'utf8')
    await pdfWin.loadFile(tmpPath)
    // printBackground is required for the yellow paste boxes / colored backgrounds.
    const buffer = await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' },
    })

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export to PDF',
      defaultPath: defaultName,
      filters: [
        { name: 'PDF Document', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, buffer)
    return filePath
  } finally {
    if (!pdfWin.isDestroyed()) pdfWin.destroy()
    unlink(tmpPath).catch(() => {})
  }
})

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
