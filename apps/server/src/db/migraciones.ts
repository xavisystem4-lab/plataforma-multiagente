/**
 * Migraciones en orden. Nunca edites una ya publicada: agrega una nueva.
 * SQL compatible con SQLite; en producción se usará PostgreSQL con el mismo modelo.
 */
export const MIGRACIONES: { version: number; nombre: string; sql: string }[] = [
  {
    version: 1,
    nombre: 'usuarios_sesiones_auditoria',
    sql: `
      CREATE TABLE usuarios (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        rol TEXT NOT NULL CHECK (rol IN ('admin','usuario')),
        password_hash TEXT NOT NULL,
        intentos_fallidos INTEGER NOT NULL DEFAULT 0,
        bloqueado_hasta TEXT,
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TEXT NOT NULL
      );

      -- Una sesión = un dispositivo. El refresh token se guarda solo como hash SHA-256.
      -- "familia" agrupa las rotaciones: si se reutiliza un token ya rotado, se revoca la familia.
      CREATE TABLE sesiones (
        id TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        familia TEXT NOT NULL,
        refresh_hash TEXT NOT NULL UNIQUE,
        dispositivo TEXT,
        ip TEXT,
        creada_en TEXT NOT NULL,
        ultimo_uso TEXT NOT NULL,
        expira_en TEXT NOT NULL,
        revocada_en TEXT,
        motivo_revocacion TEXT
      );
      CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id);
      CREATE INDEX idx_sesiones_familia ON sesiones(familia);

      -- Registro de auditoría: solo inserciones.
      CREATE TABLE auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        usuario_id TEXT,
        agente_id TEXT,
        proyecto_id TEXT,
        accion TEXT NOT NULL,
        detalle TEXT,
        ip TEXT
      );
      CREATE TRIGGER auditoria_sin_update BEFORE UPDATE ON auditoria
        BEGIN SELECT RAISE(ABORT, 'La auditoría no se puede modificar'); END;
      CREATE TRIGGER auditoria_sin_delete BEFORE DELETE ON auditoria
        BEGIN SELECT RAISE(ABORT, 'La auditoría no se puede borrar'); END;
    `,
  },
  {
    version: 2,
    nombre: 'proveedores_agentes_proyectos',
    sql: `
      -- Claves API cifradas con la bóveda (contexto "proveedor:<id>"). clave_final = últimos 4 caracteres.
      CREATE TABLE proveedores (
        id TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL CHECK (tipo IN ('anthropic','openai','openai_compatible')),
        url_base TEXT,
        clave_cifrada TEXT,
        clave_final TEXT,
        prueba_ok INTEGER,
        prueba_fecha TEXT,
        prueba_mensaje TEXT,
        modelos_disponibles TEXT NOT NULL DEFAULT '[]',
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        UNIQUE (usuario_id, nombre)
      );

      CREATE TABLE agentes (
        id TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        rol TEXT NOT NULL,
        instrucciones TEXT NOT NULL DEFAULT '',
        -- RESTRICT: no se puede borrar un proveedor que usan agentes.
        proveedor_id TEXT NOT NULL REFERENCES proveedores(id) ON DELETE RESTRICT,
        modelo TEXT NOT NULL,
        herramientas TEXT NOT NULL,
        limites TEXT NOT NULL,
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        UNIQUE (usuario_id, nombre)
      );

      -- Token de GitHub cifrado (contexto "proyecto:<id>:github").
      CREATE TABLE proyectos (
        id TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        repositorio TEXT NOT NULL,
        rama_base TEXT NOT NULL,
        privado INTEGER NOT NULL,
        url_repo TEXT NOT NULL,
        token_cifrado TEXT NOT NULL,
        token_final TEXT NOT NULL,
        validaciones TEXT NOT NULL DEFAULT '[]',
        limites TEXT NOT NULL,
        avisos TEXT NOT NULL DEFAULT '[]',
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        UNIQUE (usuario_id, repositorio)
      );

      CREATE TABLE proyecto_agentes (
        proyecto_id TEXT NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
        agente_id TEXT NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
        habilitado_en TEXT NOT NULL,
        PRIMARY KEY (proyecto_id, agente_id)
      );

      CREATE INDEX idx_auditoria_usuario ON auditoria(usuario_id, id);
    `,
  },
  {
    version: 3,
    nombre: 'tareas_eventos',
    sql: `
      CREATE TABLE tareas (
        id TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        proyecto_id TEXT NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
        agente_id TEXT NOT NULL REFERENCES agentes(id) ON DELETE RESTRICT,
        objetivo TEXT NOT NULL,
        estado TEXT NOT NULL,
        rama TEXT NOT NULL,
        -- Pregunta pendiente al usuario y el id de la llamada de herramienta que la hizo.
        pregunta TEXT,
        pregunta_llamada TEXT,
        resumen TEXT,
        error TEXT,
        -- Conversación con el modelo (formato interno) para poder reanudar.
        conversacion TEXT NOT NULL DEFAULT '[]',
        archivos TEXT NOT NULL DEFAULT '[]',
        validaciones TEXT NOT NULL DEFAULT '[]',
        tokens_entrada INTEGER NOT NULL DEFAULT 0,
        tokens_salida INTEGER NOT NULL DEFAULT 0,
        costo_usd REAL,
        -- Tiempo de ejecución acumulado (no cuenta pausas), para el límite de minutos del agente.
        ms_ejecucion INTEGER NOT NULL DEFAULT 0,
        creada_en TEXT NOT NULL,
        iniciada_en TEXT,
        terminada_en TEXT,
        actualizada_en TEXT NOT NULL
      );
      CREATE INDEX idx_tareas_proyecto ON tareas(proyecto_id, creada_en);
      CREATE INDEX idx_tareas_usuario_estado ON tareas(usuario_id, estado);

      CREATE TABLE eventos (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id TEXT NOT NULL,
        proyecto_id TEXT NOT NULL,
        tarea_id TEXT,
        agente_id TEXT,
        tipo TEXT NOT NULL,
        datos TEXT NOT NULL,
        fecha TEXT NOT NULL
      );
      CREATE INDEX idx_eventos_usuario ON eventos(usuario_id, seq);
      CREATE INDEX idx_eventos_tarea ON eventos(tarea_id, seq);
    `,
  },
];
