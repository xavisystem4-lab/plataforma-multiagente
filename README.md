# Plataforma Multiagente

Plataforma para continuar proyectos de desarrollo con agentes de IA desde **Windows** o **Android**.
El trabajo se ejecuta en un **servidor siempre encendido**; las apps solo controlan y observan,
así que el trabajo continúa aunque cierres la laptop.

**Desarrollado por SoftGala.**

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Monorepo, backend con login seguro, app Windows (Electron) con tema SoftGala | ✅ Completada |
| F1 | Proyectos de GitHub, alta de agentes (multi-proveedor), bóveda de claves, auditoría visible | ✅ Completada |
| F2 | Orquestador, sandbox Docker por proyecto, WebSocket en tiempo real, botón "Continuar proyecto" | ✅ Completada |
| F3 | Colaboración multiagente: propuestas, revisión cruzada, coordinador, límites | ✅ Completada |
| F4 | Diff, aprobación, reversión | ✅ Completada |
| F5 | Instalador de Windows y APK de Android (Capacitor), modo claro/oscuro | ✅ Completada |
| F5+ | Ventanas de proyecto: fijados, renombrar, color y barra de avance | ✅ Completada |
| F6 | Instrucciones por voz (transcripción con OpenAI) | ✅ Completada |
| F7 | Servidor 24/7 en PC propia (Windows) publicado con Tailscale, respaldos y restauración | ✅ Completada |
| F8 | Actualización automática de la app (Windows) desde GitHub Releases | ✅ Completada |

El diseño completo está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Estructura

```
apps/server      API Fastify + TypeScript: auth, recursos, orquestador, sandbox, WebSocket
apps/desktop     App de Windows (Electron): ventana, almacén cifrado con DPAPI
apps/mobile      App Android (Capacitor): proyecto nativo, almacén seguro (Keystore), APK
packages/ui      Interfaz React compartida por Windows y Android
packages/shared  Tipos, esquemas zod y eventos compartidos
infra/           Docker, Caddy — fase F6
```

## Requisitos

- Node.js 22.13 o superior (probado con Node 24).
- Git en el servidor (lo usa el orquestador para clonar y crear ramas).
- **Docker** en el servidor para ejecutar las validaciones de forma aislada. Sin Docker, los agentes igual
  leen y editan código, pero las validaciones se reportan como **no ejecutadas** (nunca como exitosas).
- Para la APK: **JDK 21** (Capacitor 8) y el SDK de Android (viene con Android Studio). El script de
  compilación busca un JDK 21 en `JAVA_HOME`, en `%USERPROFILE%\.softgala\herramientas\jdk-21` o en Android Studio.

## Primeros pasos (desarrollo local)

```bash
npm install
npm run setup                     # genera .env con secretos aleatorios (no se sube a Git)
npm run usuario:crear -- --email tu@correo.com --nombre "Tu Nombre"   # pide la contraseña oculta
npm run dev:server                # API en http://127.0.0.1:4000
```

En otra terminal:

```bash
npm run build -w @softgala/ui     # compila la interfaz
npm start -w @softgala/desktop    # abre la app de Windows
# o, con recarga en caliente:
npm run dev:ui                    # Vite en http://localhost:5173
npm run dev:desktop
```

No existe registro público: los usuarios se crean desde la terminal del servidor. El primero es administrador.

## Uso (F1)

1. **Modelos IA**: agrega un proveedor (Anthropic, OpenAI o compatible: Ollama, OpenRouter…) y pulsa
   «Probar conexión» para verificar la clave y obtener la lista real de modelos.
2. **Agentes**: crea agentes con rol, instrucciones, modelo, herramientas autorizadas y límites.
3. **Proyectos**: conecta un repositorio de GitHub con un token *fine-grained* limitado a ese repositorio
   (permisos *Contents: Read and write* y *Metadata: Read*). Se verifican el acceso y la rama antes de guardar.
   En el detalle del proyecto habilitas agentes y defines las validaciones (tests, lint, build).
4. **Auditoría**: registro de todas las acciones (el administrador ve las de todos los usuarios).

Variables opcionales en `.env`: `MAX_AGENTES_POR_USUARIO`, `MAX_PROYECTOS_POR_USUARIO` y
`GITHUB_API_URL` (para GitHub Enterprise Server).

## Uso (F2): Continuar proyecto

1. Pulsa **Continuar proyecto** (en el Panel o en Tareas), elige el proyecto y describe el objetivo.
   Si hay una tarea pausada, puedes reanudarla con un clic.
2. El servidor clona o actualiza el repositorio y crea una rama `agentes/<objetivo>-<id>`. El agente trabaja
   ahí con sus herramientas autorizadas; **nunca hace push**.
3. En **Tareas** ves en vivo cada paso, archivo modificado, validación y mensaje del agente. Si el agente
   necesita una decisión tuya, la tarea espera tu respuesta.
4. Puedes **pausar**, **reanudar** y **cancelar**. Si el servidor se reinicia, las tareas quedan pausadas
   y se pueden reanudar.
5. Al terminar se ejecutan las validaciones del proyecto y se informa su resultado real.

Límites que detienen la ejecución: tokens, costo estimado y minutos por agente, presupuesto mensual del
proyecto, máximo de turnos por ejecución y una tarea activa por proyecto.

## Uso (F3): equipo de agentes

En **Continuar proyecto** elige **Equipo de agentes**, un coordinador, los participantes (hasta 6) y las
rondas de revisión (0 a 3). El trabajo avanza por fases:

1. **Propuestas**: cada participante analiza el proyecto (solo lectura) y entrega su propuesta, en paralelo.
2. **Revisión cruzada**: cada uno revisa las propuestas de los demás y puede actualizar la suya. Se detiene
   al llegar al máximo de rondas o antes, si todos están de acuerdo.
3. **Síntesis**: el coordinador resuelve los desacuerdos y registra un plan de subtareas (máx. 8), cada una con
   su agente y sus archivos. El plan se valida en el servidor (agentes del equipo, rutas seguras).
4. **Ejecución**: las subtareas con archivos distintos corren **en paralelo**, cada una en su rama; las que
   comparten archivos esperan a las anteriores. Cada agente **solo puede escribir en sus archivos asignados**.
5. **Integración**: se integran las ramas en la rama de la tarea (un conflicto se aborta y se informa) y se
   ejecutan las validaciones.

Cada propuesta, revisión, decisión e integración queda en un registro que no se puede modificar, con el
agente responsable. La tarea se puede pausar y reanudar en cualquier fase sin repetir lo ya hecho.

## Uso (F4): revisar, aprobar y revertir

Nada se publica en GitHub sin tu aprobación:

1. Cuando una tarea termina con cambios, aparece en **Aprobaciones** (y en el panel) como pendiente.
2. En el detalle de la tarea revisas el **diff** por archivo (líneas agregadas y eliminadas).
3. **Aprobar y publicar** sube **solo la rama del agente** (`agentes/…`) y, si lo eliges, abre un **Pull Request**
   hacia la rama base. La rama principal nunca se modifica desde la plataforma: la fusión la haces tú en GitHub.
4. **Rechazar** evita la publicación; opcionalmente **descarta** la rama y los archivos de trabajo del servidor.
5. **Revertir** una tarea publicada: si el PR no se fusionó, se cierra y se borra la rama remota; si ya se
   fusionó, se abre un **PR de reversión** (`revertir/…`) para que lo revises.

El token de GitHub necesita permiso de escritura (*Contents: Read and write*) y, para abrir PR,
*Pull requests: Read and write*. Salvaguarda en el código: solo se pueden publicar o borrar ramas `agentes/*`
y `revertir/*`, con refspec explícito y sin `--force`.

## Instaladores (F5)

```bash
npm run dist:windows   # → apps/desktop/dist/PlataformaMultiagente-Setup-<versión>.exe
npm run dist:android   # → apps/mobile/dist/PlataformaMultiagente-<versión>-debug.apk
```

**Windows**: instalador NSIS en español (elige carpeta, accesos directos). El instalador **no está firmado**
con un certificado de firma de código, así que Windows SmartScreen mostrará una advertencia hasta que se firme.
La app empaquetada tiene los fusibles de Electron endurecidos (sin `RunAsNode`, sin `NODE_OPTIONS`, sin
argumentos de inspección, integridad del asar) y se cierra si se lanza con `--remote-debugging-port`.

**Android**: la APK de depuración se instala activando "Instalar apps desconocidas". Para publicar, compila la
versión release **con tu propio keystore** (nunca se guarda en el repositorio):

```bash
SOFTGALA_KEYSTORE=ruta/al/keystore.jks SOFTGALA_KEYSTORE_PASSWORD=… SOFTGALA_KEY_ALIAS=… SOFTGALA_KEY_PASSWORD=… \
  npm run apk -w @softgala/mobile -- --release
```

Seguridad de la app Android: refresh token cifrado con AES-256-GCM y clave del **Android Keystore** (plugin
nativo `AlmacenSeguro`), sin respaldos en la nube ni transferencia entre dispositivos, solo HTTPS
(HTTP únicamente hacia el emulador `10.0.2.2` para desarrollo), `FLAG_SECURE` (sin capturas ni vista previa
en Recientes) y sin depuración remota del WebView. En el teléfono, configura la dirección de tu servidor en
"Cambiar" (debe ser HTTPS).

## Apariencia: modo claro y oscuro

Selector de tema desde el login, el menú lateral y Seguridad → Apariencia: **Claro**, **Oscuro** o
**Automático** (sigue al sistema en vivo). Al cambiar, el nuevo tema se expande en círculo desde el botón
(View Transitions); se respeta "reducir movimiento" del sistema.

## Ventanas de proyecto, fijados y avance

- **Fijar**: con el alfiler de la tarjeta (o en Proyectos → Configurar → *Ventana y apariencia*), el proyecto
  aparece en la sección **Fijados** del menú lateral, con su color y su porcentaje de avance.
- **Ventanas múltiples** (Windows): *Abrir en ventana* abre una ventana independiente por proyecto (se pueden
  tener varias abiertas a la vez) con el progreso en vivo, la actividad reciente y la opción **Siempre encima**.
  En Android se muestra como una vista dentro de la app (*Ver progreso*).
- **Renombrar**: el lápiz de la barra de la ventana cambia su nombre (solo afecta a cómo se muestra; el
  repositorio no cambia). Vacío = nombre del proyecto.
- **Color**: 10 colores; pinta la barra de título de la ventana (también la nativa de Windows), la franja de la
  tarjeta y la barra de avance.
- **Barra de avance**: en modo equipo es real (fases y subtareas completadas); en modo individual es una
  **estimación** (se marca con «≈»), porque el trabajo total de un agente no se conoce de antemano; llega a
  100 % al completarse.

Todas las ventanas comparten una sola sesión: el proceso principal de Electron renueva el token por ellas
(el refresh token ya no es accesible desde la interfaz), así que abrir varias no dispara la detección de
reutilización de tokens. Cerrar sesión en una ventana la cierra en todas.

## Instrucciones por voz (F6)

1. En **Modelos IA** agrega un proveedor **OpenAI** con tu clave (o uno compatible que ofrezca
   `/audio/transcriptions`, como un servidor Whisper local). Anthropic no ofrece transcripción.
2. En **Modelos IA → Instrucciones por voz** elige ese proveedor, el idioma y el modelo
   (`gpt-4o-mini-transcribe` por defecto; `gpt-4o-transcribe` es más preciso; también `whisper-1`).
3. Pulsa el micrófono en **Continuar proyecto** o al **responder a un agente**. Mientras grabas, el anillo
   rojo sigue el volumen de tu voz; pulsa de nuevo para transcribir o **Esc** para cancelar (máximo 2 min).

El texto dictado **solo se agrega al campo**: lo revisas y decides si lo envías. Las aprobaciones siguen
siendo con clic. El audio viaja a tu servidor, que lo reenvía al proveedor y lo descarta (no se guarda); la
auditoría registra solo metadatos (tamaño, modelo, número de caracteres), nunca lo dictado.

Permisos: en Windows la app solo concede el micrófono (nunca la cámara) y solo a su propia interfaz; si no
funciona, revisa *Configuración → Privacidad → Micrófono → Permitir que las apps de escritorio accedan*.
En Android se pide el permiso de micrófono la primera vez que pulsas el botón.

## Servidor 24/7 en tu PC (F7)

Para que los agentes trabajen aunque cierres la laptop o el celular, el servidor corre en una PC con
Windows que dejas encendida y se publica **solo para tus dispositivos** con **Tailscale** (red privada).
Guía completa paso a paso: **[servidor/README.md](servidor/README.md)**.

Resumen (en PowerShell, en la carpeta del proyecto):

```powershell
npm install
node servidorpreparar-servidor.mjs          # crea .env.servidor y muestra tu MASTER_KEY (guárdala)
npm run usuario:crear -- --email tu@correo.com --nombre "Tu Nombre"
powershell -ExecutionPolicy Bypass -File servidorpublicar-tailscale.ps1   # HTTPS en tu red privada
node servidoriniciar.mjs                      # arranca el servidor
powershell -ExecutionPolicy Bypass -File servidorinstalar-autoarranque.ps1  # que arranque solo
```

En la app (Windows y Android), en **Servidor**, pon la dirección `https://<tu-pc>.<tu-red>.ts.net`.

**Respaldos**: automáticos cada 24 h en `datos-servidor/respaldos/`; manual con `npm run respaldo:crear`.
**Mudarte de PC**: con un respaldo `.db` + tu MASTER_KEY, la PC nueva queda idéntica (ver la guía).

## Actualización automática (F8)

La app de Windows muestra abajo a la izquierda su **versión** y abajo a la derecha un botón
**Actualizar**. Al pulsarlo busca una versión nueva en **GitHub Releases**, la descarga con una
**barra de progreso** y, al terminar, ofrece **reiniciar e instalar**. Nada se instala sin que lo
pulses. En Android y web solo se muestra la versión.

Para que funcione, las versiones se publican en el repositorio configurado en
`apps/desktop/package.json` (`build.publish`). Publicar una versión nueva:

```powershell
# 1) Sube la versión en los package.json (y versionName/versionCode de Android).
# 2) Compila y publica en GitHub Releases (crea el tag y sube el instalador + latest.yml):
setx GH_TOKEN "<token de GitHub con permiso repo>"   # una vez; abre otra terminal después
npm run build -w packages/ui
npx electron-builder -c apps/desktop/package.json --win nsis --publish always
```

La app compara su versión con la última publicada; si hay una mayor, aparece **Actualizar**.
El repositorio de releases debe ser accesible por la app (público, o privado con token).

## Pruebas

```bash
npm test          # pruebas del servidor (vitest)
npm run typecheck # tipos de todos los paquetes
```

## Seguridad (resumen)

- Contraseñas con scrypt (N=2^17), comparación en tiempo constante y el mismo tiempo de respuesta si el correo no existe.
- Bloqueo de 15 min tras 5 intentos fallidos y límite de peticiones por IP.
- Token de acceso JWT de 15 min y refresh token opaco de 30 días que se rota en cada uso; si se reutiliza un token ya rotado, se revoca la sesión completa.
- Sesiones por dispositivo, revocables desde **Seguridad**, con efecto inmediato.
- Secretos de proveedores y GitHub cifrados con AES-256-GCM, ligados a su registro.
- Auditoría de solo inserción (la base de datos impide modificarla o borrarla).
- App de Windows: `contextIsolation`, `sandbox`, sin Node en la interfaz, CSP estricta, navegación externa bloqueada; refresh token cifrado con DPAPI.
- El cliente exige HTTPS, salvo para un servidor en el mismo equipo.
