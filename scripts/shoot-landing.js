"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const cliArgs = process.argv
  .slice(1)
  .filter((arg) => !arg.startsWith("-") && path.resolve(arg) !== __filename);
const out = cliArgs[0] || "/tmp/landing";
const winH = Number(cliArgs[1] || 900);
const scrollY = Number(cliArgs[2] || 0);
fs.mkdirSync(out, { recursive: true });
const url = "file://" + path.resolve(__dirname, "../site/index.html");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: winH, show: false,
    backgroundColor: "#ede8dc",
    webPreferences: { offscreen: true, sandbox: false },
  });
  win.webContents.setFrameRate(15);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await win.loadURL(url);
  await sleep(1600);
  if (scrollY) { await win.webContents.executeJavaScript(`window.scrollTo(0, ${scrollY});`); await sleep(900); }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, `shot-${scrollY}.png`), img.toPNG());
  const h = await win.webContents.executeJavaScript("document.body.scrollHeight");
  process.stdout.write("WROTE scrollY=" + scrollY + " pageH=" + h + "\n");
  app.quit();
});
