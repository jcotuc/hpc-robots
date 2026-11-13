/**
 * Verifica la conexión con la app (Supabase) — SOLO LECTURA. No toca CSHP.
 *   npm.cmd run verificar
 */
import { createClient } from '@supabase/supabase-js'

const ok = (t) => console.log(`✅ ${t}`)
const mal = (t) => { console.log(`❌ ${t}`); fallas++ }
let fallas = 0

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.log('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env'); process.exit(1) }
ok(`Supabase: ${url}`)
const sb = createClient(url, key, { auth: { persistSession: false } })

const TABLAS = {
  rep_solicitudes: 'id, created_at, num_llamada, num_sap, tecnico_codigo, solicitante_nombre, solicitante_correo, estado, robot_tomado_por, robot_tomado_en, robot_intentos, error_motivo',
  rep_solicitud_lineas: 'id, solicitud_id, sku, cantidad, estado, cargado_cshp_en, error_motivo, ubicacion_origen, cantidad_pickeada, motivo_no_disponible',
  rep_eventos: 'id, created_at, solicitud_id, linea_id, actor, accion, detalle',
  rep_config: 'clave, valor',
  rep_perfiles: 'id, nombre, rol, tecnico_codigo, activo',
  rep_existencias: 'sku, ubicacion, existencia',
}
for (const [t, cols] of Object.entries(TABLAS)) {
  const { error } = await sb.from(t).select(cols).limit(1)
  if (error) mal(`${t}: ${error.message}`); else ok(`${t}: columnas OK`)
}

const { data: cfg } = await sb.from('rep_config').select('clave, valor')
const activo = cfg?.find((c) => c.clave === 'robot_solicitud_activo')?.valor
console.log(`\nrobot_solicitud_activo = ${JSON.stringify(activo)} ${activo === true || activo === 'true' ? '(ENCENDIDO)' : '(APAGADO: el robot no procesa nada)'}`)

const { data: pend, error } = await sb.from('rep_solicitudes')
  .select('num_llamada, tecnico_codigo, estado, created_at, rep_solicitud_lineas(sku, cantidad, estado)')
  .in('estado', ['pendiente', 'error_cshp', 'en_cshp']).order('created_at', { ascending: false }).limit(10)
if (!error) {
  console.log(`\nÚltimas solicitudes (pendiente / error_cshp / en_cshp): ${pend.length}`)
  for (const s of pend) console.log(`  ${s.estado.padEnd(11)} ${String(s.num_llamada).padEnd(14)} ${s.tecnico_codigo ?? ''}  ${(s.rep_solicitud_lineas || []).map((l) => `${l.sku}×${l.cantidad}[${l.estado}]`).join(', ')}`)
}
console.log(fallas ? `\n⚠️ ${fallas} problema(s): revisa los nombres de tablas/columnas que creó Lovable` : '\n✅ Todo listo para correr el robot')
process.exit(fallas ? 1 : 0)
