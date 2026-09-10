// Render the source vector with Chromium at full resolution; no raster source.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'hello-icon-')));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false, transparent: true, frame: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const svg = readFileSync(resolve('assets/icon.svg'), 'utf8');
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:transparent}svg{display:block}</style>' + svg));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(resolve('assets/icon.png'), image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG());
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
