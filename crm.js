// Envía el prospecto (y luego su cita) al CRM de su zona: una cuenta de Royal Sales IA por zona.
// Usa la entrada de integración que Royal Sales IA ya tiene: POST /api/website/leads con la clave de la cuenta.
// Si la misma persona se manda dos veces (mismo externalId), Royal Sales IA no la duplica: completa los datos.
import { ajustes } from './config.js'
import { nombreEstado } from './zonas.js'

const urlBase = () => (process.env.ROYAL_SALES_URL || '').trim().replace(/\/+$/, '')

/** Clave de integración de la zona; sin zona (fuera de tus estados) usa la de crmClaveVariableSinZona; si no, CRM_CLAVE */
export function claveCrm (zona) {
  const variable = zona ? zona.crmClaveVariable : ajustes.crmClaveVariableSinZona
  const porZona = variable ? process.env[variable] : ''
  return (porZona || process.env.CRM_CLAVE || '').trim()
}

export const crmConfigurado = (zona) => Boolean(urlBase() && claveCrm(zona))

/**
 * @param {object} chat  datos del chat (nombre, telefono, ciudad, estadoUS, anuncio…)
 * @param {object|null} zona
 * @param {{cita?: object, citaTexto?: string}} [extra]
 * @returns {Promise<{ok: boolean, omitido?: string, id?: string, duplicado?: boolean, error?: string}>}
 */
export async function enviarAlCrm (chat, zona, extra = {}) {
  const url = urlBase()
  const clave = claveCrm(zona)
  if (!url || !clave) return { ok: false, omitido: 'sin_configurar' }
  const telefono = String(chat.telefono || '').replace(/\D/g, '')
  if (telefono.length < 7) return { ok: false, omitido: 'sin_telefono' }

  const c = extra.cita
  const respuestas = {
    canal: 'WhatsApp (bot de citas)',
    ...(zona ? { zona: zona.nombre || zona.id, atiende: zona.atiende || '' } : {}),
    ...(chat.ciudad ? { ciudad: chat.ciudad } : {}),
    ...(chat.estadoUS ? { estado: nombreEstado(chat.estadoUS) } : {}),
    ...(chat.origen ? { origen: chat.origen } : {}),
    ...(c ? { cita: extra.citaTexto || c.inicio, modalidad: c.modalidad === 'meet' ? 'Google Meet' : 'Presencial', direccion_cita: c.direccion || '', notas_cita: c.notas || '' } : {})
  }
  const cuerpo = {
    name: (c?.nombre || chat.nombreReal || chat.nombre || 'Prospecto WhatsApp').slice(0, 120),
    phone: '+' + telefono,
    type: 'sales',
    form: 'whatsapp-bot',
    externalId: ('wa:' + chat.id).slice(0, 200),
    utmSource: 'facebook',
    utmMedium: 'whatsapp',
    ...(chat.anuncio ? { utmCampaign: chat.anuncio.slice(0, 200), adName: chat.anuncio.slice(0, 200) } : {}),
    ...(chat.anuncioId ? { adId: String(chat.anuncioId).slice(0, 200) } : {}),
    ...(chat.anuncioUrl && /^https?:\/\//.test(chat.anuncioUrl) ? { adUrl: chat.anuncioUrl.slice(0, 2000) } : {}),
    ...(chat.ciudad ? { city: chat.ciudad.slice(0, 80) } : {}),
    ...(chat.estadoUS ? { state: chat.estadoUS } : {}),
    ...(c ? { schedulePreference: `Cita agendada (${c.modalidad === 'meet' ? 'Google Meet' : 'presencial'}): ${extra.citaTexto || c.inicio}${c.direccion ? ' — ' + c.direccion : ''}`.slice(0, 240) } : {}),
    answers: Object.fromEntries(Object.entries(respuestas).map(([k, v]) => [k, String(v).slice(0, 500)]))
  }

  try {
    const r = await fetch(url + '/api/website/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Integration-Key': clave },
      body: JSON.stringify(cuerpo)
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.success) return { ok: false, error: j.error || ('HTTP ' + r.status) }
    return { ok: true, id: j.prospectId, duplicado: Boolean(j.duplicate) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
