/** Error de negocio con código estable y estado HTTP; el mensaje se muestra al usuario. */
export class ErrorApp extends Error {
  constructor(
    public readonly estado: number,
    public readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export const noAutorizado = (mensaje = 'Sesión no válida o expirada') =>
  new ErrorApp(401, 'NO_AUTORIZADO', mensaje);
export const prohibido = (mensaje = 'No tienes permiso para esta acción') =>
  new ErrorApp(403, 'PROHIBIDO', mensaje);
export const noEncontrado = (mensaje = 'Recurso no encontrado') =>
  new ErrorApp(404, 'NO_ENCONTRADO', mensaje);
