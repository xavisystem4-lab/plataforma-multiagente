import type { TipoProveedor } from '@softgala/shared';

/**
 * Tarifas de referencia en USD por millón de tokens (entrada, salida), tomadas de la
 * documentación de Anthropic con fecha 2026-06-24. Son estimaciones: verifica las tarifas
 * vigentes. Para modelos sin tarifa conocida el costo es null y solo se aplica el límite de tokens.
 */
const TARIFAS_ANTHROPIC: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

export function costoEstimado(tipo: TipoProveedor, modelo: string, entrada: number, salida: number): number | null {
  if (tipo !== 'anthropic') return null;
  const tarifa = TARIFAS_ANTHROPIC[modelo];
  if (!tarifa) return null;
  return (entrada * tarifa[0] + salida * tarifa[1]) / 1_000_000;
}
