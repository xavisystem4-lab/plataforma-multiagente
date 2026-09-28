import path from 'node:path';
import { construirApp } from './app';
import { cargarConfig, ErrorConfig } from './config';
import { abrirDb } from './db';

async function iniciar(): Promise<void> {
  const config = cargarConfig();
  const db = abrirDb(path.join(config.dirDatos, 'multiagente.db'));
  const app = await construirApp({ config, db });
  const recuperadas = app.orquestador.recuperarAlIniciar();
  if (recuperadas) app.log.warn(`${recuperadas} tarea(s) quedaron pausadas por el reinicio; pueden reanudarse.`);
  const { disponible, motivo } = app.orquestador.infoSandbox;
  if (!disponible) app.log.warn(motivo ?? 'Sandbox no disponible: las validaciones no se ejecutarán.');

  const esLocal = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!esLocal && !config.confiarProxy) {
    app.log.warn('El servidor escucha fuera de localhost sin proxy TLS. En producción colócalo detrás de Caddy (HTTPS).');
  }

  const cerrar = async (senal: string) => {
    app.log.info(`Recibida ${senal}; cerrando...`);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void cerrar('SIGINT'));
  process.on('SIGTERM', () => void cerrar('SIGTERM'));

  await app.listen({ host: config.host, port: config.puerto });
}

iniciar().catch((err) => {
  console.error(err instanceof ErrorConfig ? err.message : err);
  process.exit(1);
});
