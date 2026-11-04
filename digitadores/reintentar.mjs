/**
 * Vuelve a poner en cola del robot llamadas que el robot dejó PENDIENTES por un error.
 *   node --env-file=.env reintentar.mjs LLS21-557052 LLS21-557152
 * - Solo toca llamadas pendientes por el robot y aún no digitadas.
 * - Borra su intento de registro.json (prod) para que el robot pueda volver a procesarlas.
 * Úsalo SOLO si revisaste en CSHP que el intento anterior no dejó la llamada a medias
 * (p. ej. status sin cambiar). La resolución se vuelve a escribir sin problema.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'

const ROBOT = (process.env.ROBOT_NOMBRE || 'robot-digitadores').trim().toLowerCase()
const nums = process.argv.slice(2).map((n) => n.trim().toUpperCase()).filter(Boolean)
if (!nums.length) { console.error('Uso: node --env-file=.env reintentar.mjs LLS21-123456 [...]'); process.exit(1) }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let registro = {}
try { registro = JSON.parse(readFileSync('registro.json', 'utf8')) } catch { /* vacío */ }

for (const n of nums) {
  const { data, error } = await sb.from('llamadas_actualizaciones')
    .update({ pendiente_en: null, pendiente_por: null, pendiente_motivo: null })
    .eq('num_llamada', n).eq('pendiente_por', ROBOT).is('digitado_en', null).select('id')
  if (error) { console.log(`❌ ${n}: ${error.message}`); continue }
  delete registro[`prod:${n}`]
  console.log(data.length ? `✅ ${n}: de vuelta en la cola del robot` : `⚠️ ${n}: no está pendiente por el robot (¿ya la tomó un digitador?)`)
}
writeFileSync('registro.json', JSON.stringify(registro, null, 2))
