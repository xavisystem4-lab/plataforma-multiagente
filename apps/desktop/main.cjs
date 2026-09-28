// Proceso principal de Electron (Windows).
// La interfaz es la misma de packages/ui; aquí solo se crea la ventana y se expone
// un almacén cifrado para el refresh token. El renderer no tiene acceso a Node.
const { app, BrowserWindow, ipcMain, Menu, net, protocol, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const URL_DESARROLLO = process.env.ELECTRON_DEV_URL || null;
const DIR_UI = app.isPackaged
  ? path.join(process.resourcesPath, 'ui')
  : path.resolve(__dirname, '../../packages/ui/dist');
const ORIGEN_APP = 'app://ui';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Las capturas de verificación usan un perfil aparte para no tocar la sesión real.
if (process.env.CAPTURA && !app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('temp'), 'softgala-multiagente-captura'));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Almacén cifrado (DPAPI de Windows vía safeStorage) ----------
const CLAVES_PERMITIDAS = new Set(['refreshToken', 'servidor']);
const archivoAlmacen = () => path.join(app.getPath('userData'), 'almacen.json');
const enMemoria = new Map(); // respaldo si el cifrado del sistema no está disponible

function leerAlmacen() {
  try {
    return JSON.parse(fs.readFileSync(archivoAlmacen(), 'utf8'));
  } catch {
    return {};
  }
}

function escribirAlmacen(datos) {
  fs.writeFileSync(archivoAlmacen(), JSON.stringify(datos), { mode: 0o600 });
}

/** Solo la propia interfaz puede usar el almacén. */
function validarRemitente(evento, clave) {
  const url = evento.senderFrame?.url ?? '';
  const origenValido = url.startsWith(`${ORIGEN_APP}/`) || (URL_DESARROLLO && url.startsWith(URL_DESARROLLO));
  if (!origenValido) throw new Error('Remitente no autorizado');
  if (!CLAVES_PERMITIDAS.has(clave)) throw new Error('Clave no permitida');
}

ipcMain.handle('almacen:obtener', (evento, clave) => {
  validarRemitente(evento, clave);
  if (!safeStorage.isEncryptionAvailable()) return enMemoria.get(clave) ?? null;
  const cifrado = leerAlmacen()[clave];
  if (!cifrado) return null;
  try {
    return safeStorage.decryptString(Buffer.from(cifrado, 'base64'));
  } catch {
    return null;
  }
});

ipcMain.handle('almacen:guardar', (evento, clave, valor) => {
  validarRemitente(evento, clave);
  if (typeof valor !== 'string' || valor.length > 4096) throw new Error('Valor no válido');
  if (!safeStorage.isEncryptionAvailable()) {
    // Sin cifrado del sistema no se escribe nada en disco: la sesión dura lo que la app abierta.
    enMemoria.set(clave, valor);
    return;
  }
  const datos = leerAlmacen();
  datos[clave] = safeStorage.encryptString(valor).toString('base64');
  escribirAlmacen(datos);
});

ipcMain.handle('almacen:borrar', (evento, clave) => {
  validarRemitente(evento, clave);
  enMemoria.delete(clave);
  const datos = leerAlmacen();
  delete datos[clave];
  escribirAlmacen(datos);
});

// ---------- Ventana ----------
function crearVentana() {
  const captura = process.env.CAPTURA;
  const ventana = new BrowserWindow({
    width: Number(process.env.CAPTURA_ANCHO) || 1280,
    height: Number(process.env.CAPTURA_ALTO) || 800,
    minWidth: captura ? 360 : 960,
    minHeight: captura ? 600 : 640,
    backgroundColor: '#f6f8fa',
    title: 'Plataforma Multiagente — SoftGala',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#071426', symbolColor: '#e3e8ef', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Enlaces externos: solo https y en el navegador del sistema. Nunca ventanas nuevas dentro de la app.
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  ventana.webContents.on('will-navigate', (evento, url) => {
    const permitido = url.startsWith(`${ORIGEN_APP}/`) || (URL_DESARROLLO && url.startsWith(URL_DESARROLLO));
    if (!permitido) evento.preventDefault();
  });

  ventana.once('ready-to-show', () => {
    if (!captura) ventana.show();
  });

  if (captura && !app.isPackaged) {
    // Modo de verificación (solo desarrollo): opcionalmente inicia sesión y navega,
    // luego guarda una captura de la ventana y cierra.
    ventana.webContents.once('did-finish-load', () => {
      const { CAPTURA_EMAIL: email, CAPTURA_PASSWORD: password, CAPTURA_PAGINA: pagina, CAPTURA_CLIC: clic } = process.env;
      if (email && password) {
        setTimeout(() => void ventana.webContents.executeJavaScript(guionLogin(email, password, pagina, clic)), 800);
      }
      setTimeout(async () => {
        const imagen = await ventana.webContents.capturePage();
        fs.mkdirSync(path.dirname(captura), { recursive: true });
        fs.writeFileSync(captura, imagen.toPNG());
        app.quit();
      }, Number(process.env.CAPTURA_ESPERA) || 2000);
    });
  }

  void ventana.loadURL(URL_DESARROLLO ?? `${ORIGEN_APP}/index.html`);
  return ventana;
}

/** Llena el formulario como lo haría una persona (React necesita el evento "input"). */
function guionLogin(email, password, pagina, clic) {
  return `(async () => {
    const escribir = (id, valor) => {
      const el = document.getElementById(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, valor);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // Si la sesión guardada ya se restauró, no hay formulario.
    if (document.getElementById('email')) {
      escribir('email', ${JSON.stringify(email)});
      escribir('password', ${JSON.stringify(password)});
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('button[type=submit]').click();
    }
    const pagina = ${JSON.stringify(pagina ?? '')};
    if (pagina) {
      await new Promise((r) => setTimeout(r, 1500));
      [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('span')?.textContent.trim() === pagina)?.click();
    }
    // Varios clics separados por "|" (p. ej. abrir un diálogo y elegir una opción).
    for (const clic of ${JSON.stringify(clic ?? '')}.split('|').filter(Boolean)) {
      await new Promise((r) => setTimeout(r, ${Number(process.env.CAPTURA_PAUSA) || 1200}));
      [...document.querySelectorAll('.contenido button, .contenido tr[tabindex]')].find((b) => b.textContent.includes(clic))?.click();
    }
    const desplazar = ${Number(process.env.CAPTURA_DESPLAZAR) || 0};
    if (desplazar) {
      await new Promise((r) => setTimeout(r, 1500));
      document.querySelector('.contenido').scrollTop = desplazar;
    }
  })()`;
}

app.whenReady().then(() => {
  // Sirve la interfaz compilada bajo app://ui, sin permitir salir de su carpeta.
  protocol.handle('app', (req) => {
    const { host, pathname } = new URL(req.url);
    const ruta = path.normalize(path.join(DIR_UI, decodeURIComponent(pathname)));
    if (host !== 'ui' || !ruta.startsWith(DIR_UI + path.sep)) return new Response('Prohibido', { status: 403 });
    return net.fetch(pathToFileURL(ruta).toString());
  });

  // La app no necesita cámara, micrófono, notificaciones del navegador, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permiso, responder) => responder(false));

  Menu.setApplicationMenu(null);
  let ventana = crearVentana();

  app.on('second-instance', () => {
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) ventana = crearVentana();
  });
});

app.on('window-all-closed', () => app.quit());
