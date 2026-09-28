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
| F5 | Instalador de Windows y APK de Android (Capacitor) | Siguiente |
| F6 | Despliegue remoto (VPS o PC propia) y endurecimiento | Pendiente |

El diseño completo está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Estructura

```
apps/server      API Fastify + TypeScript: auth, recursos, orquestador, sandbox, WebSocket
apps/desktop     App de Windows (Electron): ventana, almacén cifrado con DPAPI
apps/mobile      App Android (Capacitor) — fase F5
packages/ui      Interfaz React compartida por Windows y Android
packages/shared  Tipos, esquemas zod y eventos compartidos
infra/           Docker, Caddy — fase F6
```

## Requisitos

- Node.js 22.13 o superior (probado con Node 24).
- Git en el servidor (lo usa el orquestador para clonar y crear ramas).
- **Docker** en el servidor para ejecutar las validaciones de forma aislada. Sin Docker, los agentes igual
  leen y editan código, pero las validaciones se reportan como **no ejecutadas** (nunca como exitosas).
- Para la APK (F5): JDK 17+ y Android SDK.

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
