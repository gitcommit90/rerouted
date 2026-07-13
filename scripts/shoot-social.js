"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const sourceArg = process.argv.find((arg) => arg.endsWith(".html"));
const outputArg = process.argv.find((arg) => arg.endsWith(".png"));
const source = path.resolve(sourceArg || path.join(__dirname, "../site/social-card.html"));
const output = path.resolve(outputArg || path.join(__dirname, "../site/social-card.png"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1201,
    height: 631,
    useContentSize: true,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: "#ede8dc",
    webPreferences: { offscreen: true, sandbox: false },
  });

  await win.loadFile(source);
  await win.webContents.executeJavaScript("document.fonts.ready");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 630 });
  fs.writeFileSync(output, image.toPNG());
  process.stdout.write(`WROTE ${output}\n`);
  app.quit();
});
