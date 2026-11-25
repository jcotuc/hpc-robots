import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const { data, error } = await sb.from('llamadas_actualizaciones').select('*, llamadas_centros(nombre)').ilike('numero_llamada', '%564608%')
if (error) console.log(error)
for (const r of data || []) { const o = { ...r }; for (const k of Object.keys(o)) if (/fallas|observ|foto|imagen/i.test(k)) delete o[k]; console.log(JSON.stringify(o, null, 1)) }
const t = await sb.from('llamadas_tecnicos').select('nombre, tipo, llamadas_centros(nombre)').ilike('nombre', '%jerez%')
console.log(JSON.stringify(t.data), t.error)
