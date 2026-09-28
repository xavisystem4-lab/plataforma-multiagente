// Puente mínimo y tipado entre la interfaz y el proceso principal.
// La interfaz solo puede leer/guardar/borrar claves permitidas del almacén cifrado.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('softgala', {
  plataforma: 'electron',
  almacen: {
    obtener: (clave) => ipcRenderer.invoke('almacen:obtener', clave),
    guardar: (clave, valor) => ipcRenderer.invoke('almacen:guardar', clave, valor),
    borrar: (clave) => ipcRenderer.invoke('almacen:borrar', clave),
  },
});
