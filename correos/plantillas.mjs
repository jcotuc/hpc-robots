// plantillas.mjs — asunto y cuerpo HTML por tipo de correo. datos = columna `datos` de correos_cola.
// Tipo nuevo = agregar una entrada aquí (y git pull en la PC del robot).
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fecha = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toLocaleString('es-GT', { timeZone: 'America/Guatemala', dateStyle: 'short', timeStyle: 'short' }) : esc(v) }
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')

const ROJO = '#c8102e'
const filas = (pares) => pares.filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#111827"><b>${esc(v)}</b></td></tr>`).join('')

/** items: [{sku, descripcion, cantidad}] → tabla */
const tablaItems = (items) => !Array.isArray(items) || !items.length ? '' : `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px;font-size:13px">
    <tr style="background:#f3f4f6"><th align="left" style="padding:8px 10px;color:#374151">SKU</th><th align="left" style="padding:8px 10px;color:#374151">Descripción</th><th align="right" style="padding:8px 10px;color:#374151">Cant.</th></tr>
    ${items.map((i) => `<tr><td style="padding:8px 10px;border-top:1px solid #e5e7eb">${esc(i.sku)}</td><td style="padding:8px 10px;border-top:1px solid #e5e7eb">${esc(i.descripcion)}</td><td align="right" style="padding:8px 10px;border-top:1px solid #e5e7eb">${esc(i.cantidad)}</td></tr>`).join('')}
  </table>`

const boton = (texto, url) => !url ? '' : `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr>
    <td style="background:${ROJO};border-radius:4px"><a href="${esc(url)}" style="display:inline-block;padding:11px 22px;color:#ffffff;text-decoration:none;font-weight:600">${esc(texto)}</a></td>
  </tr></table>`

/** etiqueta de estado: color = fondo */
const etiqueta = (texto, color) => `<span style="display:inline-block;padding:4px 10px;border-radius:12px;background:${color};color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.5px">${esc(texto)}</span>`

const marco = (titulo, cuerpo) => `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">
      <tr><td style="background:${ROJO};padding:14px 24px;color:#ffffff;font-size:13px;font-weight:600;letter-spacing:.5px">CENTROS DE SERVICIO HPC</td></tr>
      <tr><td style="padding:24px">
        <h2 style="margin:0 0 14px;font-size:20px;color:#111827">${esc(titulo)}</h2>
        ${cuerpo}
      </td></tr>
      <tr><td style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">Correo automático. No responder a este mensaje.</td></tr>
    </table>
  </td></tr></table></body></html>`

export const PLANTILLAS = {
  autoconsumo_solicitud: (d) => ({
    asunto: `Autoconsumo ${d.numero ?? ''} pendiente de autorizar — ${d.centro ?? ''}`.trim(),
    html: marco('Autoconsumo pendiente de autorizar', `
      <p style="margin:0 0 14px">${etiqueta('PENDIENTE', '#d97706')}</p>
      <p style="margin:0 0 16px"><b>${esc(d.solicitante || 'Un usuario')}</b> registró un autoconsumo que necesita tu autorización.</p>
      <table role="presentation" cellpadding="0" cellspacing="0">${filas([['No.', d.numero], ['Solicitante', d.solicitante], ['Centro', d.centro], ['Tipología', d.tipologia], ['Llamada', d.llamada], ['Fecha', d.fecha && fecha(d.fecha)], ['Comentario', d.comentario || d.motivo], ['Total', d.total]])}</table>
      ${tablaItems(d.items)}
      ${boton('Revisar autoconsumo', d.url || (APP_URL && `${APP_URL}${d.ruta || ''}`))}`),
  }),

  autoconsumo_resuelto: (d) => {
    const ok = /aprob|autoriz/i.test(d.resultado ?? '')
    const txt = ok ? 'AUTORIZADO' : 'RECHAZADO'
    return {
      asunto: `Autoconsumo ${d.numero ?? ''} ${txt.toLowerCase()}`.replace(/\s+/g, ' '),
      html: marco(`Tu autoconsumo fue ${txt.toLowerCase()}`, `
        <p style="margin:0 0 14px">${etiqueta(txt, ok ? '#15803d' : '#b91c1c')}</p>
        <table role="presentation" cellpadding="0" cellspacing="0">${filas([['No.', d.numero], ['Centro', d.centro], ['Tipología', d.tipologia], [ok ? 'Autorizado por' : 'Rechazado por', d.autorizador], ['Fecha', (d.resuelto_en || d.fecha) && fecha(d.resuelto_en || d.fecha)], [ok ? 'Comentario' : 'Motivo del rechazo', ok ? null : (d.motivo_rechazo || d.comentario)], ['Total', d.total]])}</table>
        ${tablaItems(d.items)}
        ${boton('Ver autoconsumo', d.url || (APP_URL && `${APP_URL}${d.ruta || ''}`))}`),
    }
  },
}

/* ---------- Cambios por garantía / Notas de crédito ---------- */
const producto = (sku, desc) => [sku, desc].filter(Boolean).join(' — ')
const foto = (url) => !url ? '' : `
  <p style="margin:16px 0 0"><a href="${esc(url)}"><img src="${esc(url)}" alt="Foto del producto" width="220" style="max-width:220px;border:1px solid #e5e7eb;border-radius:4px"></a><br>
  <a href="${esc(url)}" style="color:#6b7280;font-size:12px">Ver foto</a></p>`
const datosGarantia = (d) => {
  const nc = d.caso === 'Nota de crédito'
  return filas([
    ['Llamada', d.llamada], ['Centro', d.centro], ['Solicitante', d.solicitante],
    ['Tipología', nc ? null : d.tipologia],
    [nc ? 'Producto' : 'Producto que ingresa', producto(d.sku_viejo, d.desc_viejo)],
    ['Producto que se entrega', nc ? null : producto(d.sku_nuevo, d.desc_nuevo)],
    ['Valor', d.precio], ['Registrado', d.fecha && fecha(d.fecha)], ['Comentario', d.comentario],
  ])
}
const urlDe = (d) => d.url || (APP_URL && `${APP_URL}${d.ruta || ''}`)
/** género: 'Nota de crédito' es femenino → autorizada / rechazada */
const gen = (d, palabra) => (d.caso === 'Nota de crédito' ? palabra.replace(/o\b/, 'a') : palabra)
const garantiaPorRevisar = (tit, intro, etiq, color, botonTxt) => (d, titulo = typeof tit === 'function' ? tit(d) : tit) => ({
  asunto: `${d.caso} ${d.numero ?? ''} ${titulo.toLowerCase()} — ${d.centro ?? ''}`.replace(/\s+/g, ' ').trim(),
  html: marco(`${d.caso} ${titulo.toLowerCase()}`, `
    <p style="margin:0 0 14px">${etiqueta(etiq, color)}</p>
    <p style="margin:0 0 16px">${intro(d)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0">${datosGarantia(d)}</table>
    ${foto(d.foto)}
    ${boton(botonTxt, urlDe(d))}`),
})

PLANTILLAS.garantia_taller = garantiaPorRevisar('esperando tu visto bueno',
  (d) => `<b>${esc(d.solicitante || 'Un técnico')}</b> registró ${d.caso === 'Nota de crédito' ? 'una nota de crédito' : 'un cambio por garantía'} en tu centro que necesita tu visto bueno.`,
  'VISTO BUENO', '#d97706', 'Revisar en Taller')
PLANTILLAS.garantia_pendiente = garantiaPorRevisar('pendiente de autorizar',
  (d) => `${d.caso === 'Nota de crédito' ? 'Una nota de crédito' : 'Un cambio por garantía'}${d.vb_taller ? ` con visto bueno de ${esc(d.vb_taller)}` : ''} necesita tu autorización.`,
  'PENDIENTE', '#d97706', 'Revisar y autorizar')
PLANTILLAS.garantia_digitador = garantiaPorRevisar((d) => `${gen(d, 'autorizado')} por confirmar`,
  (d) => `${d.caso === 'Nota de crédito' ? 'La nota de crédito' : 'El cambio por garantía'} fue ${gen(d, 'autorizado')}${d.autorizador ? ` por ${esc(d.autorizador)}` : ''} y está ${gen(d, 'listo')} para confirmar.`,
  'AUTORIZADO', '#15803d', 'Ir a Digitadores')
PLANTILLAS.garantia_resuelto = (d) => {
  const ok = /autoriz/i.test(d.resultado ?? '')
  const txt = (ok ? gen(d, 'autorizado') : gen(d, 'rechazado')).toUpperCase()
  return {
    asunto: `${d.caso} ${d.numero ?? ''} ${txt.toLowerCase()}`.replace(/\s+/g, ' '),
    html: marco(`Tu ${d.caso.toLowerCase()} fue ${txt.toLowerCase()}`, `
      <p style="margin:0 0 14px">${etiqueta(txt, ok ? '#15803d' : '#b91c1c')}</p>
      <table role="presentation" cellpadding="0" cellspacing="0">${filas([
        [ok ? `${gen(d, 'Autorizado')} por` : `${gen(d, 'Rechazado')} por`, d.autorizador], [`${gen(d, 'Resuelto')} el`, d.resuelto_en && fecha(d.resuelto_en)],
        ['Motivo del rechazo', ok ? null : d.motivo_rechazo]])}${datosGarantia(d)}</table>
      ${boton('Ver mis garantías', urlDe(d))}`),
  }
}

/** Si la fila trae asunto/html propios, se respetan. */
export function armarCorreo(fila) {
  const p = PLANTILLAS[fila.tipo]
  if (!p && !(fila.asunto && fila.html)) throw new Error(`Sin plantilla para tipo "${fila.tipo}"`)
  const base = p ? p(fila.datos || {}) : {}
  return { asunto: fila.asunto || base.asunto, html: fila.html || base.html }
}
