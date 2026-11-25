/**
 * Revisa en Supabase el centro y técnico de una llamada y en qué centro está ese técnico (solo lectura).
 *   node --env-file=.env revisar-tecnico.mjs LLS21-564608
 */
import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
for (const num of process.argv.slice(2)) {
  const { data, error } = await sb.from('llamadas_actualizaciones').select('*, llamadas_centros(nombre)').ilike('numero_llamada', `%${num.replace(/^\D+-?/, '')}%`)
  if (error) { console.log(error.message); continue }
  for (const r of data || []) {
    console.log(`\n${r.numero_llamada} · centro Bandeja: ${r.llamadas_centros?.nombre} · técnico: ${r.tecnico_nombre}`)
    for (const k of Object.keys(r)) if (/creado|subido|usuario|correo|email|user/i.test(k)) console.log(`   ${k}: ${r[k]}`)
    const apellido = String(r.tecnico_nombre || '').trim().split(/\s+/).pop()
    const t = await sb.from('llamadas_tecnicos').select('nombre, tipo, llamadas_centros(nombre)').ilike('nombre', `%${apellido}%`)
    for (const x of t.data || []) console.log(`   catálogo: ${x.nombre} · ${x.tipo} · centro ${x.llamadas_centros?.nombre}`)
  }
}
