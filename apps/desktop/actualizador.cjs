// Actualización automática de la app (Windows) desde GitHub Releases.
// La interfaz muestra la versión y un botón "Actualizar"; aquí se busca, descarga (con progreso)
// e instala la nueva versión. Nunca se instala nada sin que la persona pulse el botón.
const { app, ipcMain, BrowserWindow } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  // electron-updater no está disponible (p. ej. ejecutando sin empaquetar): las actualizaciones
  // quedan deshabilitadas, pero la app funciona igual.
}

/** Estado que ve la interfaz. fase: inactivo | buscando | disponible | descargando | lista | al-dia | error */
let estado = { fase: 'inactivo', version: app.getVersion(), disponible: null, porcentaje: 0, mensaje: null };

function registrarActualizador({ validarRemitente, habilitado }) {
  const soportado = !!autoUpdater && habilitado;

  const difundir = () => {
    for (const v of BrowserWindow.getAllWindows()) {
      if (!v.isDestroyed()) v.webContents.send('actualizacion:estado', estado);
    }
  };
  const fijar = (cambios) => {
    estado = { ...estado, ...cambios };
    difundir();
  };

  if (soportado) {
    autoUpdater.autoDownload = false; // solo se descarga cuando la persona lo pide
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => fijar({ fase: 'buscando', mensaje: null }));
    autoUpdater.on('update-available', (info) => fijar({ fase: 'disponible', disponible: info.version, porcentaje: 0, mensaje: null }));
    autoUpdater.on('update-not-available', () => fijar({ fase: 'al-dia', disponible: null, mensaje: null }));
    autoUpdater.on('download-progress', (p) => fijar({ fase: 'descargando', porcentaje: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => fijar({ fase: 'lista', disponible: info.version, porcentaje: 100 }));
    autoUpdater.on('error', (err) => fijar({ fase: 'error', mensaje: mensajeError(err) }));
  }

  ipcMain.handle('actualizacion:estado', (e) => {
    validarRemitente(e);
    return { ...estado, soportado };
  });

  ipcMain.handle('actualizacion:buscar', async (e) => {
    validarRemitente(e);
    if (!soportado) return { soportado: false };
    // Si ya se descargó, "buscar" no reinicia el ciclo.
    if (estado.fase === 'descargando' || estado.fase === 'lista') return { soportado: true };
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      fijar({ fase: 'error', mensaje: mensajeError(err) });
    }
    return { soportado: true };
  });

  ipcMain.handle('actualizacion:descargar', async (e) => {
    validarRemitente(e);
    if (!soportado || (estado.fase !== 'disponible' && estado.fase !== 'error')) return;
    fijar({ fase: 'descargando', porcentaje: 0, mensaje: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      fijar({ fase: 'error', mensaje: mensajeError(err) });
    }
  });

  ipcMain.handle('actualizacion:instalar', (e) => {
    validarRemitente(e);
    if (!soportado || estado.fase !== 'lista') return;
    // Cierra la app e instala; isSilent=false muestra el instalador, isForceRunAfter reabre la app.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });

  // Búsqueda silenciosa al arrancar (no descarga; solo informa si hay algo nuevo).
  if (soportado) {
    app.whenReady().then(() => {
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
    });
  }
}

function mensajeError(err) {
  const m = err && err.message ? String(err.message) : 'Error al actualizar';
  if (/net::|ENOTFOUND|ETIMEDOUT|getaddrinfo|EAI_AGAIN/i.test(m)) return 'No hay conexión para buscar actualizaciones.';
  if (/404|No published versions|latest\.yml/i.test(m)) return 'Aún no hay versiones publicadas para actualizar.';
  return 'No se pudo actualizar. Intenta más tarde.';
}

module.exports = { registrarActualizador };
