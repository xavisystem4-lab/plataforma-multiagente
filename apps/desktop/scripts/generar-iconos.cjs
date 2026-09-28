// Genera los íconos PNG (Windows y Android) a partir de los SVG de /recursos.
// Uso: npx electron scripts/generar-iconos.cjs <archivo-salida.json>
// El JSON describe [{ svg, salida, tamano }]. Se ejecuta con Electron para no depender de módulos nativos.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const trabajos = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

app.whenReady().then(async () => {
  const ventana = new BrowserWindow({ show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  for (const { svg, salida, tamano } of trabajos) {
    const contenido = fs.readFileSync(svg, 'utf8');
    ventana.setContentSize(tamano, tamano);
    const html = `<html><body style="margin:0;background:transparent"><img style="width:${tamano}px;height:${tamano}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(contenido).toString('base64')}"></body></html>`;
    await ventana.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await new Promise((r) => setTimeout(r, 150));
    const imagen = await ventana.webContents.capturePage({ x: 0, y: 0, width: tamano, height: tamano });
    fs.mkdirSync(path.dirname(salida), { recursive: true });
    fs.writeFileSync(salida, imagen.resize({ width: tamano, height: tamano }).toPNG());
    console.log(`${salida} (${tamano}px)`);
  }
  app.quit();
});
