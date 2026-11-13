/**
 * Regresa a 'pendiente' una solicitud que quedó en error_cshp, para que el robot la vuelva a tomar.
 *   npm.cmd run reintentar -- LLS21-560046
 * Solo cambia solicitudes en error_cshp y sus líneas en error_cshp/pendiente. Deja evento en rep_eventos.
 */
import { createClient } from '@supabase/supabase-js'
const num = String(process.argv[2] || '').trim().toUpperCase()
if (!/^LL[SM]\d+-\d+$/.test(num)) { console.error('Uso: npm.cmd run reintentar -- LLS21-123456'); process.exit(1) }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const { data, error } = await sb.from('rep_solicitudes').select('id, estado, error_motivo').eq('num_llamada', num).eq('estado', 'error_cshp')
if (error) { console.error(`❌ ${error.message}`); process.exit(1) }
if (!data.length) { console.log(`No hay solicitudes de ${num} en error_cshp. Nada que hacer.`); process.exit(0) }
for (const s of data) {
  const l = await sb.from('rep_solicitud_lineas').update({ estado: 'pendiente', error_motivo: null }).eq('solicitud_id', s.id).eq('estado', 'error_cshp').select('id')
  const r = await sb.from('rep_solicitudes').update({ estado: 'pendiente', error_motivo: null, robot_tomado_por: null, robot_tomado_en: null }).eq('id', s.id).eq('estado', 'error_cshp').select('id')
  await sb.from('rep_eventos').insert({ solicitud_id: s.id, actor: 'reintento-manual', accion: 'reintentar', detalle: { error_anterior: s.error_motivo, lineas: l.data?.length ?? 0 } })
  console.log(r.error || l.error ? `❌ ${r.error?.message || l.error?.message}` : `✅ ${num}: de nuevo en pendiente (${l.data.length} línea(s)). Error anterior: ${s.error_motivo}`)
}
