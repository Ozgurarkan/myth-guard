import { app, BrowserWindow, dialog, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = 5173;
let mainWindow;
let server;
let ownsServer = false;

async function loadProductionServer() {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const entry = join(base, 'server', 'net', 'serve.js');
  return import(pathToFileURL(entry).href);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: 'Myth Guard — Game Master',
    icon: join(app.getAppPath(), 'dist', 'brand', 'icon-512.png'),
    backgroundColor: '#060916',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) event.preventDefault();
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
}

async function launch() {
  try {
    const { startProductionServer } = await loadProductionServer();
    const root = app.isPackaged ? join(process.resourcesPath, 'dist') : join(app.getAppPath(), 'dist');
    server = await startProductionServer({
      port: PORT,
      root,
      dataDir: app.getPath('userData'),
      quiet: true,
    });
    ownsServer = Boolean(server);
    createWindow();
  } catch (error) {
    await writeFile(join(app.getPath('userData'), 'startup-error.txt'), `${error.stack ?? error}\n`).catch(() => {});
    await dialog.showMessageBox({
      type: 'error',
      title: 'Myth Guard could not start',
      message: error.message,
      detail: `Myth Guard uses local port ${PORT} so players can join from the same Wi-Fi network.`,
    });
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(launch);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', async event => {
  if (!ownsServer || !server) return;
  event.preventDefault();
  const current = server;
  server = null;
  ownsServer = false;
  await current.close();
  app.quit();
});
