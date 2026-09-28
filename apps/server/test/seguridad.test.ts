import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cargarConfig, ErrorConfig } from '../src/config';
import { abrirDb } from '../src/db';
import { auditar } from '../src/auditoria';
import { Boveda, enmascarar } from '../src/security/boveda';
import { hashPassword, verificarPassword } from '../src/security/passwords';
import { firmarAccessToken, verificarAccessToken } from '../src/security/tokens';

describe('contraseñas', () => {
  it('verifica la correcta y rechaza la incorrecta', async () => {
    const hash = await hashPassword('una contraseña larga');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('una contraseña larga');
    expect(await verificarPassword('una contraseña larga', hash)).toBe(true);
    expect(await verificarPassword('otra contraseña', hash)).toBe(false);
  });

  it('usa sal distinta en cada hash', async () => {
    expect(await hashPassword('igual')).not.toBe(await hashPassword('igual'));
  });

  it('rechaza formatos desconocidos sin lanzar', async () => {
    expect(await verificarPassword('x', 'md5$abc')).toBe(false);
  });
});

describe('bóveda de secretos', () => {
  const boveda = new Boveda(randomBytes(32));

  it('cifra y descifra con el mismo contexto', () => {
    const sobre = boveda.cifrar('sk-secreto-123', 'proveedor:1');
    expect(sobre).not.toContain('sk-secreto-123');
    expect(boveda.descifrar(sobre, 'proveedor:1')).toBe('sk-secreto-123');
  });

  it('no descifra con otro contexto (secreto movido de registro)', () => {
    const sobre = boveda.cifrar('sk-secreto-123', 'proveedor:1');
    expect(() => boveda.descifrar(sobre, 'proveedor:2')).toThrow();
  });

  it('detecta alteraciones del texto cifrado', () => {
    const [v, iv, tag, datos] = boveda.cifrar('sk-secreto-123', 'c').split('.');
    const alterado = [v, iv, tag, `A${datos!.slice(1)}`].join('.');
    expect(() => boveda.descifrar(alterado, 'c')).toThrow();
  });

  it('no descifra con otra clave maestra', () => {
    const sobre = boveda.cifrar('dato', 'c');
    expect(() => new Boveda(randomBytes(32)).descifrar(sobre, 'c')).toThrow();
  });

  it('enmascara mostrando solo los últimos 4 caracteres', () => {
    expect(enmascarar('sk-abcdef1234')).toBe('••••1234');
  });
});

describe('tokens de acceso', () => {
  const secreto = randomBytes(32);

  it('firma y verifica', async () => {
    const t = await firmarAccessToken({ sub: 'u1', sid: 's1', rol: 'admin' }, secreto, 60);
    expect(await verificarAccessToken(t, secreto)).toEqual({ sub: 'u1', sid: 's1', rol: 'admin' });
  });

  it('rechaza un token firmado con otro secreto', async () => {
    const t = await firmarAccessToken({ sub: 'u1', sid: 's1', rol: 'admin' }, randomBytes(32), 60);
    await expect(verificarAccessToken(t, secreto)).rejects.toThrow();
  });
});

describe('configuración', () => {
  it('falla con mensaje claro si faltan secretos', () => {
    expect(() => cargarConfig({})).toThrow(ErrorConfig);
    expect(() => cargarConfig({})).toThrow(/npm run setup/);
  });

  it('rechaza una clave maestra de tamaño incorrecto', () => {
    expect(() =>
      cargarConfig({ JWT_SECRET: 'x'.repeat(40), MASTER_KEY: randomBytes(16).toString('base64') }),
    ).toThrow(/MASTER_KEY/);
  });
});

describe('auditoría', () => {
  it('no permite modificar ni borrar registros', () => {
    const db = abrirDb(':memory:');
    auditar(db, { accion: 'prueba' });
    expect(() => db.exec("UPDATE auditoria SET accion = 'otra'")).toThrow(/no se puede modificar/);
    expect(() => db.exec('DELETE FROM auditoria')).toThrow(/no se puede borrar/);
  });
});
