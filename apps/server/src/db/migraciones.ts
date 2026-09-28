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
];
