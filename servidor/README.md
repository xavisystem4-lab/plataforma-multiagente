# Servidor de la Plataforma Multiagente (PC propia con Windows)

El servidor es la pieza que trabaja **siempre**, aunque cierres la laptop o el celular: en él corren
los agentes, se guardan los proyectos y las claves cifradas. Esta guía lo instala en una PC con
**Windows** que dejes encendida, y lo publica **solo para tus dispositivos** con **Tailscale**
(una red privada; nada queda expuesto a Internet).

> Resumen: la PC servidor corre el servidor en `127.0.0.1:4000`; Tailscale lo publica como
> `https://<tu-pc>.<tu-red>.ts.net`; esa dirección es la que pones en la app de Windows y de Android.

---

## 1. Requisitos en la PC servidor

Primero copia el proyecto a la PC servidor (clónalo desde GitHub o copia la carpeta completa, por
ejemplo en `C:\Multiagente`). Luego, en **PowerShell** dentro de esa carpeta:

```powershell
# Instala Node.js y Tailscale automáticamente (con winget, ya incluido en Windows 10/11):
powershell -ExecutionPolicy Bypass -File servidor\instalar-requisitos.ps1
# ...o, si además quieres Docker (para las validaciones; requiere reiniciar):
powershell -ExecutionPolicy Bypass -File servidor\instalar-requisitos.ps1 -ConDocker
```

Cierra y vuelve a abrir PowerShell al terminar (para que el sistema reconozca `node` y `tailscale`).

Después, en la app de **Tailscale**: inicia sesión con tu cuenta y, en la consola de administración
(admin console → DNS), activa **MagicDNS** y **HTTPS Certificates**.

> Instalación manual (alternativa): **Node.js 22+** desde https://nodejs.org, **Tailscale** desde
> https://tailscale.com/download, y **Docker Desktop** (opcional) desde https://docker.com.
> Sin Docker, las validaciones (tests) de los proyectos se informan como «no ejecutadas».

## 2. Instalar y configurar (una sola vez)

Abre **PowerShell** en la carpeta del proyecto y ejecuta, en orden:

```powershell
npm install
node servidor\preparar-servidor.mjs
```

`preparar-servidor.mjs` crea `.env.servidor` con secretos nuevos y muestra tu **MASTER_KEY**.
**Guárdala** en un gestor de contraseñas: sin ella no se pueden restaurar los respaldos ni
mudar el servidor de PC.

Crea tu usuario (el primero es administrador):

```powershell
npm run usuario:crear -- --email tu@correo.com --nombre "Tu Nombre"
```

## 3. Publicar con Tailscale y arrancar

```powershell
# Publica el servidor como HTTPS dentro de tu red privada (muestra la dirección a usar en las apps):
powershell -ExecutionPolicy Bypass -File servidor\publicar-tailscale.ps1

# Arranca el servidor:
node servidor\iniciar.mjs
```

Apunta la dirección `https://<tu-pc>.<tu-red>.ts.net` que muestra el script: es la que escribirás en
la app, en el campo **Servidor**.

## 4. Que arranque solo al encender la PC

```powershell
powershell -ExecutionPolicy Bypass -File servidor\instalar-autoarranque.ps1
```

Crea un acceso directo en la carpeta de Inicio de Windows (no instala ningún servicio del sistema).
El servidor arrancará la próxima vez que inicies sesión en esa PC. El registro queda en
`servidor\servidor.log`. Para quitarlo: el mismo script con `-Quitar`.

> La PC debe quedar **encendida y con tu sesión de Windows iniciada**. En *Configuración → Sistema →
> Inicio/apagado* conviene poner que **no se suspenda** cuando está conectada a corriente.

## 5. Conectar la laptop y el celular

1. Instala **Tailscale** en la laptop y en el celular, e inicia sesión con la **misma cuenta**.
2. Abre la app (Windows o Android), y en **Servidor** escribe
   `https://<tu-pc>.<tu-red>.ts.net`. Inicia sesión con el usuario que creaste.

Solo tus dispositivos dentro de la red Tailscale pueden llegar al servidor.

## 6. Respaldos

- **Automáticos**: cada 24 h se guarda una copia en `datos-servidor\respaldos\` (se conservan 7).
  Se configura con `RESPALDO_CADA_HORAS` y `RESPALDOS_A_CONSERVAR` en `.env.servidor`.
- **Manual**:

  ```powershell
  npm run respaldo:crear                 # en datos-servidor\respaldos\
  npm run respaldo:crear -- --dir D:\copias   # en otra carpeta o disco externo
  ```

Guarda de vez en cuando una copia **fuera de la PC** (disco externo o nube), junto con tu MASTER_KEY
(en un lugar separado).

## 7. Mudarte de PC (o recuperar tras un problema)

Necesitas **dos cosas**: un archivo de respaldo `.db` y la **MASTER_KEY** con que se creó.

1. En la PC nueva, haz los pasos 1 y 2 (instalar, `preparar-servidor.mjs`).
2. Abre `.env.servidor` y **reemplaza** la línea `MASTER_KEY=...` por tu MASTER_KEY guardada
   (si usas otra, las claves API y tokens de GitHub guardados no se podrán descifrar).
3. Detén el servidor si está corriendo y restaura el respaldo:

   ```powershell
   npm run respaldo:restaurar -- --archivo D:\copias\multiagente-2026-09-28_1430.db
   ```

4. Publica con Tailscale (paso 3) y arranca. La **dirección `.ts.net` cambia** (es otra PC): actualiza
   el campo **Servidor** en la app. Tus proyectos, agentes y usuarios siguen intactos.

## Preguntas frecuentes

- **¿Y si cambio de PC servidor?** Sigue el paso 7: con el respaldo `.db` + la MASTER_KEY, la PC nueva
  queda idéntica. Lo único que cambia para las apps es la dirección del servidor (otra `.ts.net`).
- **¿Puedo mover el servidor a un VPS después?** Sí: es el mismo servidor. Copiarías el proyecto al
  VPS, restaurarías el respaldo con la misma MASTER_KEY y usarías un dominio/HTTPS en vez de Tailscale.
- **¿Se pierde algo si se apaga la PC?** No. Las tareas en curso quedan **pausadas** y se reanudan al
  volver a arrancar. Nada se corrompe.
- **¿Es seguro?** El servidor solo escucha en `127.0.0.1`; Tailscale lo publica cifrado y solo para tus
  dispositivos. Las claves API y tokens van cifrados con la MASTER_KEY.
