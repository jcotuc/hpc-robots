// kardex-pausa.mjs — pausa SOLO en la PC donde corre el robot Kardex.
// kardex\sincronizar.py crea hpc-robots\.pausa-kardex al empezar y lo borra al terminar.
// Cada robot llama salirSiKardex() al arrancar: si el archivo existe, se salta esa corrida.
// El archivo vence solo a los 45 min (si Kardex se cae, nadie queda pausado). Si algo falla al revisar, NO pausa.
// Los robots de otras PCs no se pausan: el cruce de inventario usa la hora de la lectura (rep_kardex_comparar).
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ARCHIVO = fileURLToPath(new URL('../.pausa-kardex', import.meta.url))
const MAX_MIN = 45

export function pausaKardexPC() {
  try {
    const st = statSync(ARCHIVO)
    if (Date.now() - st.mtimeMs > MAX_MIN * 60000) return null
    return readFileSync(ARCHIVO, 'utf8').trim() || 'Kardex actualizando inventario'
  } catch { return null }
}

/** Al inicio de cada robot: si Kardex está trabajando en esta PC, se salta esta corrida (sale con código 0). */
export async function salirSiKardex(robot) {
  const motivo = pausaKardexPC()
  if (!motivo) return
  console.log(`⏸️  ${new Date().toLocaleTimeString('es-GT')} ${robot}: corrida omitida · ${motivo}`)
  process.exit(0)
}
