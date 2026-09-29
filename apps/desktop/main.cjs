// Proceso principal de Electron (Windows).
// La interfaz es la misma de packages/ui. Aquí se crean las ventanas (principal y una por proyecto),
// se guarda la sesión cifrada con DPAPI y se renueva el token para TODAS las ventanas a la vez.
// El renderer no tiene acceso a Node ni al refresh token.
const { app, BrowserWindow, ipcMain, Menu, net, protocol, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registrarActualizador } = require('./actualizador.cjs');

const URL_DESARROLLO = process.env.ELECTRON_DEV_URL || null;
const DIR_UI = app.isPackaged
  ? path.join(process.resourcesPath, 'ui')
  : path.resolve(__dirname, '../../packages/ui/dist');
const ORIGEN_APP = 'app://ui';
const URL_INICIO = URL_DESARROLLO ?? `${ORIGEN_APP}/index.html`;
const COLOR_BARRA = '#071426';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// En la app instalada no se permite depuración remota: otro programa del equipo podría controlarla.
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
}

// Las capturas de verificación usan un perfil aparte para no tocar la sesión real.
const CAPTURA = process.env.CAPTURA && !app.isPackaged ? process.env.CAPTURA : null;
if (CAPTURA) {
  app.setPath('userData', path.join(app.getPath('temp'), 'softgala-multiagente-captura'));
  // Verificación del dictado sin micrófono real: Chromium genera un tono de prueba.
  if (process.env.CAPTURA_MICROFONO_FALSO) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Almacén cifrado (DPAPI de Windows vía safeStorage) ----------
// La interfaz solo puede leer/escribir "servidor". El refresh token lo maneja únicamente este proceso.
const CLAVES_INTERFAZ = new Set(['servidor']);
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

function leerSecreto(clave) {
  if (!safeStorage.isEncryptionAvailable()) return enMemoria.get(clave) ?? null;
  const cifrado = leerAlmacen()[clave];
  if (!cifrado) return null;
  try {
    return safeStorage.decryptString(Buffer.from(cifrado, 'base64'));
  } catch {
    return null;
  }
}

function guardarSecreto(clave, valor) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Sin cifrado del sistema no se escribe nada en disco: la sesión dura lo que la app abierta.
    enMemoria.set(clave, valor);
    return;
  }
  const datos = leerAlmacen();
  datos[clave] = safeStorage.encryptString(valor).toString('base64');
  escribirAlmacen(datos);
}

function borrarSecreto(clave) {
  enMemoria.delete(clave);
  const datos = leerAlmacen();
  delete datos[clave];
  escribirAlmacen(datos);
}

/** Solo la propia interfaz puede usar estos canales. */
function validarRemitente(evento) {
  const url = evento.senderFrame?.url ?? '';
  const valido = url.startsWith(`${ORIGEN_APP}/`) || (URL_DESARROLLO && url.startsWith(URL_DESARROLLO));
  if (!valido) throw new Error('Remitente no autorizado');
}

ipcMain.handle('almacen:obtener', (e, clave) => {
  validarRemitente(e);
  if (!CLAVES_INTERFAZ.has(clave)) throw new Error('Clave no permitida');
  return leerSecreto(clave);
});
ipcMain.handle('almacen:guardar', (e, clave, valor) => {
  validarRemitente(e);
  if (!CLAVES_INTERFAZ.has(clave)) throw new Error('Clave no permitida');
  if (typeof valor !== 'string' || valor.length > 4096) throw new Error('Valor no válido');
  guardarSecreto(clave, valor);
});
ipcMain.handle('almacen:borrar', (e, clave) => {
  validarRemitente(e);
  if (!CLAVES_INTERFAZ.has(clave)) throw new Error('Clave no permitida');
  borrarSecreto(clave);
});

// ---------- Sesión compartida entre ventanas ----------
// Cada renovación rota el refresh token; si dos ventanas renovaran a la vez, el servidor lo tomaría
// como un token robado y cerraría la sesión. Por eso se renueva aquí, una sola vez, para todas.
let acceso = null; // { token, expira }
let renovando = null;

/** HTTPS obligatorio, salvo servidores de desarrollo en este equipo. */
function validarServidor(url) {
  const u = new URL(url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('Servidor no permitido');
  return u.origin;
}

function avisarATodas(canal) {
  for (const v of BrowserWindow.getAllWindows()) if (!v.isDestroyed()) v.webContents.send(canal);
}

ipcMain.handle('sesion:establecer', (e, refreshToken, accessToken, expiraEnSeg) => {
  validarRemitente(e);
  if (typeof refreshToken !== 'string' || refreshToken.length > 400 || typeof accessToken !== 'string') throw new Error('Datos no válidos');
  guardarSecreto('refreshToken', refreshToken);
  acceso = { token: accessToken, expira: Date.now() + Number(expiraEnSeg) * 1000 };
});

ipcMain.handle('sesion:renovar', async (e, forzar, servidor) => {
  validarRemitente(e);
  if (!forzar && acceso && acceso.expira - Date.now() > 60_000) return { accessToken: acceso.token };
  renovando ??= (async () => {
    const refreshToken = leerSecreto('refreshToken');
    if (!refreshToken) return null;
    let r;
    try {
      r = await fetch(`${validarServidor(servidor)}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('SIN_CONEXION');
    }
    if (r.status === 401) {
      borrarSecreto('refreshToken');
      acceso = null;
      avisarATodas('sesion:cerrada');
      return null;
    }
    if (!r.ok) throw new Error('SIN_CONEXION');
    const d = await r.json();
    guardarSecreto('refreshToken', d.refreshToken);
    acceso = { token: d.accessToken, expira: Date.now() + d.expiraEn * 1000 };
    return { accessToken: d.accessToken };
  })().finally(() => {
    renovando = null;
  });
  return renovando;
});

ipcMain.handle('sesion:limpiar', (e) => {
  validarRemitente(e);
  acceso = null;
  borrarSecreto('refreshToken');
  avisarATodas('sesion:cerrada');
});

// ---------- Actualizaciones (solo app empaquetada, no en modo captura) ----------
registrarActualizador({ validarRemitente, habilitado: app.isPackaged && !CAPTURA });

// ---------- Ventanas ----------
const ventanasProyecto = new Map(); // proyectoId → BrowserWindow
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^#[0-9a-f]{6}$/i;
const limpiarTitulo = (t) => String(t ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'Proyecto';

/** Texto claro u oscuro según el color de fondo, para los botones de la barra de Windows. */
function colorSimbolos(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#0b1f3a' : '#ffffff';
}

function crearVentana({ ruta = '', titulo = 'Plataforma Multiagente — SoftGala', color = COLOR_BARRA, ancho, alto, minAncho, minAlto } = {}) {
  const ventana = new BrowserWindow({
    width: ancho,
    height: alto,
    minWidth: minAncho,
    minHeight: minAlto,
    backgroundColor: '#f6f8fa',
    title: titulo,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color, symbolColor: colorSimbolos(color), height: 40 },
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
  // El título lo decide la app (nombre de ventana del proyecto), no el <title> de la página.
  ventana.on('page-title-updated', (e) => e.preventDefault());
  ventana.once('ready-to-show', () => {
    if (!CAPTURA) ventana.show();
  });

  void ventana.loadURL(`${URL_INICIO}${ruta}`);
  return ventana;
}

function crearVentanaPrincipal() {
  const ventana = crearVentana({
    ruta: CAPTURA && process.env.CAPTURA_RUTA ? process.env.CAPTURA_RUTA : '',
    ancho: Number(process.env.CAPTURA_ANCHO) || 1280,
    alto: Number(process.env.CAPTURA_ALTO) || 800,
    minAncho: CAPTURA ? 360 : 960,
    minAlto: CAPTURA ? 600 : 640,
  });
  if (CAPTURA) prepararCaptura(ventana, CAPTURA);
  return ventana;
}

ipcMain.handle('ventana:abrir-proyecto', (e, proyectoId, titulo, color) => {
  validarRemitente(e);
  if (!UUID.test(String(proyectoId))) throw new Error('Proyecto no válido');
  const colorValido = HEX.test(String(color)) ? color : COLOR_BARRA;
  const existente = ventanasProyecto.get(proyectoId);
  if (existente && !existente.isDestroyed()) {
    if (existente.isMinimized()) existente.restore();
    existente.focus();
    return;
  }
  const ventana = crearVentana({
    ruta: `#/proyecto/${proyectoId}`,
    titulo: limpiarTitulo(titulo),
    color: colorValido,
    ancho: 900,
    alto: 660,
    minAncho: 420,
    minAlto: 360,
  });
  ventanasProyecto.set(proyectoId, ventana);
  ventana.on('closed', () => ventanasProyecto.delete(proyectoId));
  if (CAPTURA) prepararCaptura(ventana, CAPTURA.replace(/\.png$/i, '-ventana.png'), false);
});

/** La ventana de un proyecto ajusta su propio título, color y "siempre encima". */
ipcMain.handle('ventana:configurar', (e, opciones) => {
  validarRemitente(e);
  const ventana = BrowserWindow.fromWebContents(e.sender);
  if (!ventana) return null;
  if (opciones?.titulo !== undefined) ventana.setTitle(limpiarTitulo(opciones.titulo));
  if (opciones?.color !== undefined && HEX.test(String(opciones.color))) {
    ventana.setTitleBarOverlay({ color: opciones.color, symbolColor: colorSimbolos(opciones.color), height: 40 });
  }
  if (typeof opciones?.encima === 'boolean') ventana.setAlwaysOnTop(opciones.encima, 'floating');
  return { encima: ventana.isAlwaysOnTop() };
});

// ---------- Modo de verificación (solo desarrollo) ----------
/** Inicia sesión y navega si se pide, guarda una captura y (en la ventana principal) cierra la app. */
function prepararCaptura(ventana, destino, principal = true) {
  // Muestra en la terminal los errores de la página (útil para diagnosticar pantallas en blanco).
  ventana.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[página:${e.level}] ${e.message}`);
  });
  ventana.webContents.once('did-finish-load', () => {
    const { CAPTURA_EMAIL: email, CAPTURA_PASSWORD: password, CAPTURA_PAGINA: pagina, CAPTURA_CLIC: clic } = process.env;
    if (principal) setTimeout(() => void ventana.webContents.executeJavaScript(guionLogin(email, password, pagina, clic)), 800);
    const espera = principal ? Number(process.env.CAPTURA_ESPERA) || 2000 : Number(process.env.CAPTURA_ESPERA_VENTANA) || 3000;
    setTimeout(async () => {
      const imagen = await ventana.webContents.capturePage();
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, imagen.toPNG());
      if (principal && !process.env.CAPTURA_ESPERA_VENTANA) app.quit();
      if (!principal) app.quit();
    }, espera);
  });
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
    if (${JSON.stringify(Boolean(email && password))} && document.getElementById('email')) {
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
      // Por nombre accesible (p. ej. el selector de tema) o por texto visible.
      const objetivos = [...document.querySelectorAll('button, tr[tabindex]')];
      (objetivos.find((b) => b.getAttribute('aria-label') === clic) ?? objetivos.find((b) => b.closest('.contenido') && b.textContent.includes(clic)))?.click();
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

  // Único permiso concedido: el micrófono (sin cámara) para el dictado por voz, y solo a la propia
  // interfaz. Cámara, notificaciones del navegador, ubicación, etc. se niegan siempre.
  const esInterfazPropia = (url) => {
    try {
      // URL.origin es "null" para esquemas propios como app://, por eso se arma a mano.
      const aOrigen = (u) => {
        const x = new URL(u);
        return `${x.protocol}//${x.host}`;
      };
      return aOrigen(url) === ORIGEN_APP || (!!URL_DESARROLLO && aOrigen(url) === aOrigen(URL_DESARROLLO));
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((_wc, permiso, responder, detalles) => {
    const soloAudio = Array.isArray(detalles.mediaTypes) && detalles.mediaTypes.length > 0 && detalles.mediaTypes.every((t) => t === 'audio');
    responder(permiso === 'media' && soloAudio && esInterfazPropia(detalles.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permiso, origen, detalles) => permiso === 'media' && detalles.mediaType !== 'video' && esInterfazPropia(origen),
  );

  Menu.setApplicationMenu(null);
  let principal = crearVentanaPrincipal();

  app.on('second-instance', () => {
    if (principal.isDestroyed()) principal = crearVentanaPrincipal();
    if (principal.isMinimized()) principal.restore();
    principal.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) principal = crearVentanaPrincipal();
  });
});

app.on('window-all-closed', () => app.quit());
