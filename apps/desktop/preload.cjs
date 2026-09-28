// Puente mínimo y tipado entre la interfaz y el proceso principal.
// La interfaz no ve el refresh token: solo pide un token de acceso vigente.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('softgala', {
  plataforma: 'electron',
  almacen: {
    obtener: (clave) => ipcRenderer.invoke('almacen:obtener', clave),
    guardar: (clave, valor) => ipcRenderer.invoke('almacen:guardar', clave, valor),
    borrar: (clave) => ipcRenderer.invoke('almacen:borrar', clave),
  },
  sesion: {
    establecer: (refreshToken, accessToken, expiraEn) => ipcRenderer.invoke('sesion:establecer', refreshToken, accessToken, expiraEn),
    renovar: (forzar, servidor) => ipcRenderer.invoke('sesion:renovar', Boolean(forzar), servidor),
    limpiar: () => ipcRenderer.invoke('sesion:limpiar'),
    alCerrar: (fn) => {
      const oyente = () => fn();
      ipcRenderer.on('sesion:cerrada', oyente);
      return () => ipcRenderer.removeListener('sesion:cerrada', oyente);
    },
  },
  ventanas: {
    abrirProyecto: (proyectoId, titulo, color) => ipcRenderer.invoke('ventana:abrir-proyecto', proyectoId, titulo, color),
    configurar: (opciones) => ipcRenderer.invoke('ventana:configurar', opciones),
  },
});
