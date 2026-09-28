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
| F2 | Orquestador, sandbox Docker por proyecto, WebSocket en tiempo real, botón "Continuar proyecto" | Siguiente |
| F3 | Colaboración multiagente: propuestas, revisión cruzada, coordinador, límites | Pendiente |
| F4 | Diff, aprobación, reversión | Pendiente |
| F5 | Instalador de Windows y APK de Android (Capacitor) | Pendiente |
| F6 | Despliegue remoto (VPS o PC propia) y endurecimiento | Pendiente |

El diseño completo está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Estructura

```
apps/server      API Fastify + TypeScript: auth, proveedores, agentes, proyectos, auditoría
apps/desktop     App de Windows (Electron): ventana, almacén cifrado con DPAPI
apps/mobile      App Android (Capacitor) — fase F5
packages/ui      Interfaz React compartida por Windows y Android
packages/shared  Tipos, esquemas zod y eventos compartidos
infra/           Docker, Caddy — fase F6
```

## Requisitos

- Node.js 22.13 o superior (probado con Node 24).
- Para la APK (F5): JDK 17+ y Android SDK. Para el sandbox (F2): Docker Desktop.

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
