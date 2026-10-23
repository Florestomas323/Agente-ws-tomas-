// Mantiene al día el CRM de cada zona (una cuenta/workspace de Royal Sales IA por zona).
// - El prospecto entra por POST /api/website/leads (Royal Sales IA no lo duplica: lo completa).
// - Sus cambios (cita agendada, reprogramada, confirmada, cancelada, no interesado, avances)
//   van por POST /api/website/leads/status.
// Todo pasa por una cola guardada en el volumen: si Royal Sales IA no responde, se reintenta
// solo (1, 2, 5, 15, 30 min… hasta ~1 día) y, si aun así falla, te aviso.
import { ajustes } from './config.js'
import { nombreEstado, zonaPorId, hayZonas, ofertaPorId, numeroBonito } from './zonas.js'
import { obtenerChat, crearOActualizarChat, colaCrm, encolarCrm, encolarCrmAlFrente, quitarDeColaCrm, actualizarEnColaCrm } from './almacen.js'

const urlBase = () => (process.env.ROYAL_SALES_URL || '').trim().replace(/\/+$/, '')
const ESPERAS_MIN = [1, 2, 5, 15, 30, 60, 120, 240, 480, 720]

/** Clave de integración de la zona; sin zona (fuera de tus estados) usa la de crmClaveVariableSinZona; si no, CRM_CLAVE */
export function claveCrm (zona) {
  const variable = zona ? zona.crmClaveVariable : ajustes.crmClaveVariableSinZona
  const porZona = variable ? process.env[variable] : ''
  return (porZona || process.env.CRM_CLAVE || '').trim()
}

export const crmConfigurado = (zona) => Boolean(urlBase() && claveCrm(zona))

/** ¿Ya sabemos a qué workspace va este chat? (zona, o ciudad fuera de zonas → cuenta "sin zona") */
const destinoConocido = (chat) => Boolean(chat && (!hayZonas() || chat.zona || chat.ciudad))

const corto = (v, n = 500) => String(v ?? '').slice(0, n)
const modalidadTexto = (c) => c.modalidad === 'meet' ? 'Google Meet' : 'Presencial'

/** Respuestas que se ven en la ficha del prospecto en Royal Sales IA */
function respuestasDe (chat, zona) {
  const oferta = ofertaPorId(chat.oferta)
  const r = {
    canal: 'WhatsApp (Sofía)',
    ...(zona ? { zona: zona.nombre || zona.id, atiende: zona.atiende || '' } : {}),
    ...(chat.ciudad ? { ciudad: chat.ciudad } : {}),
    ...(chat.estadoUS ? { estado: nombreEstado(chat.estadoUS) } : {}),
    ...(chat.codigoPostal ? { codigo_postal: chat.codigoPostal } : {}),
    ...(chat.origen ? { origen: chat.origen } : {}),
    ...(oferta ? { promocion: oferta.nombre || oferta.id } : {}),
    ...(chat.avance ? { etapa_sofia: chat.avance } : {}),
    ...(chat.regalo ? { regalo_obtenido: chat.regalo.nombre + (chat.regalo.codigo ? ` (${chat.regalo.codigo})` : '') } : {})
  }
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v).map(([k, v]) => [k, corto(v)]))
}

function cuerpoLead (chat, zona, cita) {
  const telefono = String(chat.telefono || '').replace(/\D/g, '')
  return {
    name: corto(cita?.nombre || chat.nombreReal || chat.nombre || 'Prospecto WhatsApp', 120),
    phone: '+' + telefono,
    type: 'sales',
    form: 'whatsapp-bot',
    externalId: corto('wa:' + chat.id, 200),
    utmSource: 'facebook',
    utmMedium: 'whatsapp',
    ...(chat.anuncio ? { utmCampaign: corto(chat.anuncio, 200), adName: corto(chat.anuncio, 200) } : {}),
    ...(chat.anuncioId ? { adId: corto(chat.anuncioId, 200) } : {}),
    ...(chat.anuncioUrl && /^https?:\/\//.test(chat.anuncioUrl) ? { adUrl: corto(chat.anuncioUrl, 2000) } : {}),
    ...(chat.ciudad ? { city: corto(chat.ciudad, 80) } : {}),
    ...(chat.estadoUS ? { state: chat.estadoUS } : {}),
    ...(chat.codigoPostal ? { zip: corto(chat.codigoPostal, 16) } : {}),
    ...(chat.regalo ? { gift: corto(chat.regalo.nombre, 160) } : {}),
    answers: respuestasDe(chat, zona)
  }
}

/** Dirección para Royal Sales IA: completa (calle, ciudad, estado, ZIP) o nada */
function ubicacionDe (cita) {
  const zip = (String(cita.direccion || '').match(/\b\d{5}(?:-\d{4})?\b/) || [])[0] || cita.codigoPostal || ''
  if (cita.modalidad === 'meet' || !cita.direccion || !cita.ciudad || !cita.estadoUS || !zip) return undefined
  return { addressLine1: corto(cita.direccion, 200), city: corto(cita.ciudad, 80), state: cita.estadoUS, postalCode: zip }
}

/** Cita en el formato de la ruta de estados */
export function citaParaCrm (cita, citaTexto) {
  return {
    ref: cita.id,
    scheduledAt: cita.inicio,
    durationMinutes: Math.max(1, Math.round((Date.parse(cita.fin) - Date.parse(cita.inicio)) / 60000) || 40),
    mode: cita.modalidad === 'meet' ? 'video' : 'in_person',
    ...(ubicacionDe(cita) ? { location: ubicacionDe(cita) } : {}),
    notes: corto([
      `Agendada por Sofía (WhatsApp): ${citaTexto || cita.inicio}`,
      `Modalidad: ${modalidadTexto(cita)}${cita.meetEnlace ? ' — ' + cita.meetEnlace : ''}`,
      cita.direccion ? `Dirección: ${cita.direccion}` : '',
      `Atiende: ${cita.atiende || 'Tomás'}`,
      cita.notas ? `Notas: ${cita.notas}` : ''
    ].filter(Boolean).join('\n'), 1500)
  }
}

// ---------- Cola ----------

/** Pone al día los datos del prospecto (se manda el estado actual del chat al procesar) */
export function sincronizarProspecto (chatId) {
  const chat = obtenerChat(chatId)
  if (!destinoConocido(chat)) return
  if (colaCrm().some(i => i.chatId === chatId && i.tipo === 'lead' && !i.intentos)) return // ya va uno en camino
  encolarCrm({ tipo: 'lead', chatId })
}

/**
 * Cambio de estado del prospecto en Royal Sales IA.
 * @param {string} chatId
 * @param {'progress'|'appointment_scheduled'|'appointment_rescheduled'|'appointment_confirmed'|'appointment_cancelled'|'not_interested'} evento
 * @param {object} [datos] { appointment, previousRef, schedulePreference, interested }
 */
export function sincronizarEstado (chatId, evento, datos = {}) {
  const chat = obtenerChat(chatId)
  if (!destinoConocido(chat)) return
  const enSuCuenta = chat.crm?.id && (chat.crm.zona || '') === (chat.zona || '')
  if (!enSuCuenta && !colaCrm().some(i => i.chatId === chatId && i.tipo === 'lead')) encolarCrm({ tipo: 'lead', chatId })
  encolarCrm({ tipo: 'estado', chatId, evento, datos })
}

async function post (ruta, clave, cuerpo) {
  const r = await fetch(urlBase() + ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Integration-Key': clave },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(20000)
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, ok: r.ok && j.success !== false, j }
}

/** Errores que no se arreglan reintentando (datos inválidos o clave mala) */
const esPermanente = (status) => [400, 401, 403, 409, 422].includes(status)

async function enviarItem (item) {
  const chat = obtenerChat(item.chatId)
  if (!chat) return { ok: true, omitido: 'sin_chat' }
  const zona = zonaPorId(chat.zona)
  const clave = claveCrm(zona)
  if (!urlBase() || !clave) return { ok: true, omitido: 'sin_configurar' }
  if (String(chat.telefono || '').replace(/\D/g, '').length < 7) return { ok: true, omitido: 'sin_telefono' }

  if (item.tipo === 'lead') {
    const r = await post('/api/website/leads', clave, cuerpoLead(chat, zona))
    if (r.ok) {
      crearOActualizarChat(chat.id, { crm: { zona: zona?.id || '', id: r.j.prospectId || r.j.leadId || chat.crm?.id || '', enviado: Date.now() } })
      return { ok: true, detalle: r.j.duplicate ? 'actualizado' : 'nuevo' }
    }
    return { ok: false, status: r.status, error: r.j.error || ('HTTP ' + r.status) }
  }

  const cuerpo = {
    externalId: 'wa:' + chat.id,
    ...(chat.crm?.id && chat.crm.zona === (zona?.id || '') ? { prospectId: chat.crm.id } : {}),
    event: item.evento,
    answers: respuestasDe(chat, zona),
    ...(chat.regalo ? { gift: corto(chat.regalo.nombre, 160) } : {}),
    ...(item.datos || {})
  }
  const r = await post('/api/website/leads/status', clave, cuerpo)
  if (r.ok) return { ok: true, detalle: item.evento }
  return { ok: false, status: r.status, error: r.j.error || ('HTTP ' + r.status) }
}

let procesando = false
/**
 * Envía lo pendiente, en orden por chat (si algo de un chat falla, lo siguiente de ese chat espera).
 * @param {(texto:string)=>Promise<void>} [avisar] aviso a Tomás cuando algo se da por perdido
 */
export async function procesarColaCrm (avisar) {
  if (procesando) return
  procesando = true
  try {
    const bloqueados = new Set()
    for (const item of [...colaCrm()]) {
      if (bloqueados.has(item.chatId)) continue
      if (item.proximo > Date.now()) { bloqueados.add(item.chatId); continue }
      let r
      try { r = await enviarItem(item) } catch (e) { r = { ok: false, error: e.message } }
      if (r.ok) {
        quitarDeColaCrm(item.id)
        if (!r.omitido) console.log(`CRM ✓ ${item.tipo} ${item.evento || ''} ${item.chatId} ${r.detalle || ''}`)
        continue
      }
      const chat = obtenerChat(item.chatId)
      // el prospecto no existe en Royal Sales IA (falló su alta o lo borraron): se vuelve a mandar
      // primero y este estado se reintenta enseguida después, sin esperar horas
      if (item.tipo === 'estado' && r.status === 404 && !item.reenviado) {
        crearOActualizarChat(item.chatId, { crm: null })
        actualizarEnColaCrm(item.id, { reenviado: true, ultimoError: r.error })
        if (!colaCrm().some(i => i.chatId === item.chatId && i.tipo === 'lead')) encolarCrmAlFrente({ tipo: 'lead', chatId: item.chatId })
        bloqueados.add(item.chatId)
        continue
      }
      const intentos = item.intentos + 1
      const quien = `${chat?.nombreReal || chat?.nombre || ''} (${numeroBonito(chat?.telefono || '')})`
      if (esPermanente(r.status) || intentos > ESPERAS_MIN.length) {
        quitarDeColaCrm(item.id)
        console.error('CRM ✗ sin reintentos', item.tipo, item.evento || '', item.chatId, r.error)
        await avisar?.(`⚠️ No pude actualizar a ${quien} en Royal Sales IA (${item.tipo === 'lead' ? 'datos del prospecto' : item.evento}): ${r.error}. Revísalo a mano.`).catch(() => {})
      } else {
        actualizarEnColaCrm(item.id, { intentos, proximo: Date.now() + ESPERAS_MIN[intentos - 1] * 60_000, ultimoError: r.error })
        console.error(`CRM reintento ${intentos} en ${ESPERAS_MIN[intentos - 1]} min`, item.tipo, item.chatId, r.error)
      }
      bloqueados.add(item.chatId)
    }
  } finally {
    procesando = false
  }
}
