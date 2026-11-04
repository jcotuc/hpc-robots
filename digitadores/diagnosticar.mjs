/**
 * Diagnóstico de por qué el robot no toma una llamada (solo lee Supabase).
 *   node --env-file=.env diagnosticar.mjs LLM21-318247 LLS21-318352
 */
import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const sinPrefijo = (n) => String(n).trim().replace(/^(?:reparaci[oó]n|diagn[oó]stico)\s*\+\s*/i, '')
const norm = (v) => normalizar(sinPrefijo(v)).replace(/\s+/g, ' ')

for (const num of process.argv.slice(2)) {
  console.log(`\n=== ${num}`)
  const { data: a, error } = await sb.from('llamadas_actualizaciones')
    .select('id, num_llamada, centro_id, tecnico_nombre, producto_sku, pendiente_por, pendiente_motivo, tomado_por, digitado_en, llamadas_centros(nombre), llamadas_estados(nombre)')
    .eq('num_llamada', num.toUpperCase()).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error || !a) { console.log('  no se pudo leer:', error?.message || 'no existe'); continue }
  console.log(`  estado ${a.llamadas_estados?.nombre} · centro ${a.centro_id} ${a.llamadas_centros?.nombre} · técnico ${JSON.stringify(a.tecnico_nombre)}`)
  console.log(`  pendiente_por ${a.pendiente_por} · motivo ${a.pendiente_motivo}`)
  console.log(`  tomado_por ${a.tomado_por} · digitado_en ${a.digitado_en}`)
  const tec = await sb.from('llamadas_tecnicos').select('nombre').eq('centro_id', a.centro_id).eq('tipo', 'reparacion')
  console.log(`  catálogo reparación del centro: ${tec.error ? 'ERROR ' + tec.error.message : (tec.data || []).length + ' técnicos'}`)
  const lista = (tec.data || []).map((t) => t.nombre)
  const buscado = norm(a.tecnico_nombre)
  const palabras = buscado.split(' ')
  const parecidos = lista.filter((v) => norm(v).split(' ').some((p) => p.length > 2 && palabras.includes(p)))
  console.log(`  parecidos: ${parecidos.join(' | ') || '(ninguno)'}`)
  for (const [n, q] of [
    ['recomendación', a.producto_sku ? sb.from('llamadas_producto_recomendaciones').select('texto').eq('sku', a.producto_sku).maybeSingle() : null],
    ['diagnóstico revisado', sb.from('llamadas_diagnostico_resultados').select('actualizacion_id').eq('actualizacion_id', a.id).maybeSingle()],
    ['machotes', sb.from('llamadas_diagnostico_machotes').select('clave')],
  ]) { if (!q) continue; const r = await q; console.log(`  ${n}: ${r.error ? 'ERROR ' + r.error.message : 'ok'}`) }
}
