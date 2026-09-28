# Arquitectura

## Principio central

Las apps (Windows y Android) **no ejecutan agentes**: son clientes. Los agentes corren en un servidor
siempre encendido (VPS o PC propia; se decide en F6). Una carpeta que solo existe en la laptop apagada
no puede continuarse: los proyectos se conectan por **GitHub**.

```
 [Windows: Electron]   [Android: Capacitor]     ← misma interfaz React (packages/ui)
          \                  /
        HTTPS + WebSocket (JWT)
                   |
        ┌──────── SERVIDOR ───────────────┐
        │ Caddy (TLS)                      │
        │ API Fastify (auth, proyectos,    │
        │   agentes, aprobaciones)         │
        │ Orquestador multiagente          │ ← coordinador, rondas, presupuestos, políticas
        │ Runner → contenedores Docker     │ ← 1 contenedor + 1 worktree Git por tarea/agente
        │ Base de datos · bóveda cifrada   │
        └──────────────────────────────────┘
                   |
      GitHub  ·  proveedores de modelos (varios, por agente)
```

## Decisiones confirmadas

| Tema | Decisión |
|---|---|
| Alojamiento | Se decide en F6; mientras tanto todo corre en local. |
| Modelos | Multi-proveedor desde el diseño: cada agente elige proveedor y modelo; varios agentes pueden trabajar a la vez en uno o varios proyectos. |
| Proyectos | GitHub, con token de permisos mínimos por repositorio. |
| Clientes | Electron (Windows) + Capacitor (Android) con interfaz React compartida. |
| Base de datos | SQLite (incluido en Node) en desarrollo; PostgreSQL en producción. |

## Modelo de datos

Existe hoy (F0–F1): `usuarios`, `sesiones`, `auditoria`, `proveedores` (clave cifrada, modelos disponibles),
`agentes` (rol, instrucciones, proveedor, modelo, herramientas, límites), `proyectos` (repo, rama, token cifrado,
validaciones, límites, avisos) y `proyecto_agentes`. Todos los recursos pertenecen a un usuario; otro usuario
recibe 404.

Planeado:

- `tareas`, `ejecuciones`, `pasos` (cada llamada a herramienta o modelo).
- `propuestas`, `revisiones`, `decisiones` (colaboración y registro de quién decidió qué).
- `conjuntos_cambios` (diff, rama, commit), `aprobaciones`, `validaciones` (comando, resultado real, salida).
- `eventos` (secuencia creciente para reenviar al reconectar), `presupuestos`.

## API

| Método | Ruta | Estado |
|---|---|---|
| POST | `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout` | ✅ |
| GET | `/api/auth/me`, `/api/auth/sesiones` | ✅ |
| DELETE | `/api/auth/sesiones/:id` | ✅ |
| GET/POST/PATCH/DELETE | `/api/proveedores`, `/api/proveedores/:id` · POST `/api/proveedores/:id/probar` | ✅ |
| GET/POST/PATCH/DELETE | `/api/agentes`, `/api/agentes/:id` | ✅ |
| GET/POST/PATCH/DELETE | `/api/proyectos`, `/api/proyectos/:id` · GET `/api/proyectos/:id/estado` | ✅ |
| PUT | `/api/proyectos/:id/agentes/:agenteId` (habilitar/deshabilitar) | ✅ |
| GET | `/api/auditoria`, `/api/resumen`, `/api/catalogo` | ✅ |
| POST | `/api/proyectos/:id/continuar` | F2 |
| POST | `/api/tareas/:id/pausar`, `/reanudar`, `/cancelar` | F2 |
| GET | `/api/tareas/:id/diff` | F4 |
| POST | `/api/aprobaciones/:id/aprobar`, `/rechazar` | F4 |
| POST | `/api/cambios/:id/revertir` | F4 |
| WS | `/api/ws?since=<seq>` | F2 |

Los tipos de evento de tiempo real están en `packages/shared/src/eventos.ts`.

## Flujo de "Continuar proyecto" (F2–F4)

1. Se clona o actualiza el repositorio en el servidor y se crea la rama `agentes/<tarea>`.
2. El coordinador arma un plan a partir del objetivo o de la tarea pendiente.
3. Los agentes proponen soluciones en paralelo.
4. Hay revisión cruzada, con un máximo de N rondas, de tiempo y de presupuesto.
5. El coordinador sintetiza, resuelve desacuerdos y asigna subtareas **solo si tocan archivos distintos**.
6. Cada agente trabaja en su propio worktree dentro de un contenedor aislado.
7. Se integra y se ejecutan las validaciones del proyecto; se reporta el resultado real de cada una.
8. El usuario revisa el diff y aprueba: se hace merge o push. Si algo falla, se detiene y se avisa.

## Seguridad

- **Políticas fuera del modelo:** el orquestador decide qué se permite, no el LLM. El contenido de los repos es dato no confiable y nunca puede cambiar políticas.
- **Aprobación obligatoria** para borrar, `push --force`, desplegar, publicar, usar secretos, acceder a la red o ejecutar comandos fuera de la lista permitida.
- **Aislamiento:** contenedor sin root y sin red por defecto, con límites de CPU, memoria y tiempo. Solo se accede al worktree del proyecto; se bloquean rutas absolutas y escapes con `..` o symlinks.
- **Claves:** nunca llegan a los clientes; se cifran con AES-256-GCM ligadas a su registro y la clave maestra se toma del entorno (KMS en producción).
- **URLs de proveedores:** HTTPS obligatorio (HTTP solo para localhost), sin IPs privadas ni credenciales en la URL, sin seguir redirecciones. Limitación conocida: un dominio público que resuelva a una IP privada no se detecta.
- **Herramientas de agentes:** leer, buscar, escribir en su rama, ejecutar validaciones configuradas y commits. Push, despliegues, red y secretos no son herramientas: requieren aprobación.
- **Sesiones:** ver README.

## Riesgos

- Costo de los tokens: se controla con topes por tarea, agente y mes, que el sistema hace cumplir.
- Inyección de instrucciones desde los repos: se controla con las políticas y las aprobaciones.
- Conflictos entre cambios en paralelo: archivos distintos por agente y validación antes de integrar.
- Android no garantiza conexiones en segundo plano: se usan notificaciones push (Firebase) y se reconecta con `since`.
- Docker y el SDK de Android aún no están instalados en el equipo de desarrollo.

## Criterios de aceptación del MVP

- Con la laptop apagada, desde la APK se inicia una tarea que termina en el servidor.
- Ningún archivo fuera del proyecto puede leerse o escribirse; hay pruebas que lo intentan.
- Ninguna acción destructiva ocurre sin aprobación.
- Los límites de rondas y presupuesto detienen la ejecución.
- Todo cambio aprobado se puede revertir.
- Ninguna validación se reporta como exitosa si no se ejecutó.
