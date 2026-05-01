import { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell } from 'electron'
import { join } from 'path'
import { writeFile, readFile } from 'fs/promises'
import { createHmac, timingSafeEqual } from 'crypto'

const HMAC_SECRET = 'graphine-integrity-v1'

function addHmac(json: string): string {
  const obj = JSON.parse(json) as { version?: number; hmac?: string; frames?: unknown[]; tabs?: unknown[] }
  const payload = obj.version === 2 ? obj.tabs : obj.frames
  obj.hmac = createHmac('sha256', HMAC_SECRET).update(JSON.stringify(payload)).digest('hex')
  return JSON.stringify(obj, null, 2)
}

function verifyAndStrip(json: string): string {
  const obj = JSON.parse(json) as { version?: number; hmac?: string; frames?: unknown[]; tabs?: unknown[] }
  if (!obj.hmac) throw new Error('Recording has no integrity signature')
  const payload = obj.version === 2 ? obj.tabs : obj.frames
  const expected = createHmac('sha256', HMAC_SECRET).update(JSON.stringify(payload)).digest('hex')
  const a = Buffer.from(obj.hmac, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b))
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
  fileMenu.append(new MenuItem({ type: 'separator' }))
  fileMenu.append(new MenuItem({
    label: 'Open Recording…',
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
    title: 'Open Recording',
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

ipcMain.handle('shell:showItemInFolder', (_e, filePath: string) => {
  shell.showItemInFolder(filePath)
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
