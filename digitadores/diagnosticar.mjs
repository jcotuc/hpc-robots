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
  if (error || !a) {
    console.log('  no se pudo leer:', error?.message || 'no existe en la Bandeja')
    // Parecidas: mismos últimos 4 dígitos (número corregido o mal escrito)
    const fin = num.slice(-4)
    const { data: par } = await sb.from('llamadas_actualizaciones')
      .select('num_llamada, created_at, tecnico_nombre, producto_sku, pendiente_por, tomado_por, digitado_por, digitado_en, llamadas_estados(nombre)')
      .ilike('num_llamada', `%${fin}`).order('created_at', { ascending: false }).limit(10)
    for (const p of par || []) console.log(`  parecida: ${p.num_llamada} · ${p.llamadas_estados?.nombre} · ${p.tecnico_nombre} · SKU ${p.producto_sku} · creada ${new Date(p.created_at).toLocaleString('es-GT')} · tomada ${p.tomado_por ?? '-'} · digitada ${p.digitado_por ?? '-'} ${p.digitado_en ?? ''}`)
    if (!par?.length) console.log('  sin llamadas parecidas (mismos últimos 4 dígitos)')
    // Historial de la Bandeja (queda aunque el registro se haya corregido o borrado)
    const { data: mov, error: emov } = await sb.from('llamadas_etiquetera_log')
      .select('created_at, accion, usuario_email, actualizacion_id').eq('num_llamada', num.toUpperCase()).order('created_at')
    if (emov) console.log('  historial: ERROR', emov.message)
    for (const m of mov || []) console.log(`  historial: ${new Date(m.created_at).toLocaleString('es-GT')} · ${m.accion} · ${m.usuario_email} · id ${m.actualizacion_id}`)
    const id = (mov || []).find((m) => m.actualizacion_id)?.actualizacion_id
    if (id) {
      const { data: hoy } = await sb.from('llamadas_actualizaciones').select('num_llamada, tecnico_nombre, producto_sku, digitado_por').eq('id', id).maybeSingle()
      console.log(hoy ? `  ese registro ahora se llama: ${hoy.num_llamada} · ${hoy.tecnico_nombre} · SKU ${hoy.producto_sku} · digitada ${hoy.digitado_por ?? '-'}` : '  ese registro ya no existe: lo eliminaron de la Bandeja')
    }
    continue
  }
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
