const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

let helperServer = null;
let mainWindow = null;

function resolveRootDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.resolve(__dirname, "..");
}

function resolveDataDir(rootDir) {
  if (!app.isPackaged) return rootDir;
  return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath));
}

async function ensureWritableDirs(dataDir) {
  await fs.promises.mkdir(path.join(dataDir, "backups"), { recursive: true });
  await fs.promises.mkdir(path.join(dataDir, "reports"), { recursive: true });
}

async function startHelper() {
  const rootDir = resolveRootDir();
  const dataDir = resolveDataDir(rootDir);
  const workspaceDir = app.isPackaged ? path.dirname(process.resourcesPath) : path.resolve(rootDir, "..");

  process.env.AI_PATCHER_ROOT_DIR = rootDir;
  process.env.AI_PATCHER_DATA_DIR = dataDir;
  process.env.AI_PATCHER_WORKSPACE_DIR = workspaceDir;

  await ensureWritableDirs(dataDir);

  const serverModuleUrl = pathToFileURL(path.join(rootDir, "helper", "server.js")).href;
  const { startServer } = await import(serverModuleUrl);
  helperServer = await startServer({ port: 0, host: "127.0.0.1" });
  return helperServer.url;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 740,
    title: "Ikemen AI Patcher",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(url);
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });
}

if (process.versions.electron) {
  app.whenReady().then(async () => {
    try {
      const url = await startHelper();
      createWindow(url);
    } catch (error) {
      dialog.showErrorBox("Ikemen AI Patcher failed to start", error?.stack || error?.message || String(error));
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && helperServer?.url) createWindow(helperServer.url);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    if (helperServer?.server) helperServer.server.close();
  });
}

module.exports = { resolveRootDir, resolveDataDir };
