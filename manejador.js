// Decide a qué mensajes contestar, cuándo callarse y cuándo avisarte.
// No depende de Baileys directamente: recibe funciones para enviar (así se puede probar sin WhatsApp).
import { ajustes } from './config.js'
import { responder, resumir, tzDelCliente, citasVigentes, marcarAvance } from './agente.js'
import { DateTime } from 'luxon'
import { ahora, formatoCita, formatoHumano } from './calendario.js'
import {
  obtenerChat, crearOActualizarChat, agregarAlHistorial, contarRespuesta, botActivo, marcarConocidos,
  listarCitas, actualizarCita, listarChats, yaProcesado, registrarCodigoRegalo
} from './almacen.js'
import {
  zonaDesdeAnuncio, zonaPorId, numerosDeZona, gruposDeZona, nombreEstado, hayZonas, quienAtiende, ofertaDesde, ofertaPorId, equipoDe, numeroBonito
} from './zonas.js'
import { sincronizarProspecto, sincronizarEstado, procesarColaCrm, citaParaCrm } from './crm.js'

const esGrupoOEspecial = (jid) =>
  !jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid === 'status@broadcast'

const digitos = (jid) => (jid || '').split('@')[0].split(':')[0]

function desenvolver (m) {
  let c = m
  for (let i = 0; i < 5 && c; i++) {
    const dentro = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message ||
      c.viewOnceMessageV2Extension?.message || c.documentWithCaptionMessage?.message || c.editedMessage?.message
    if (!dentro) break
    c = dentro
  }
  return c || {}
}

/** ¿Es una nota de voz / audio? */
export const esAudio = (mensaje) => Boolean(desenvolver(mensaje).audioMessage)

/** Saca el texto legible de un mensaje de WhatsApp (o una descripción si no es texto) */
export function leerContenido (mensaje) {
  const m = desenvolver(mensaje)
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage) return '[El cliente envió una foto]' + (m.imageMessage.caption ? ' ' + m.imageMessage.caption : '')
  if (m.videoMessage) return '[El cliente envió un video]' + (m.videoMessage.caption ? ' ' + m.videoMessage.caption : '')
  if (m.audioMessage) return '[El cliente envió una nota de voz que no se pudo escuchar]'
  if (m.documentMessage) return '[El cliente envió un documento]' + (m.documentMessage.caption ? ' ' + m.documentMessage.caption : '')
  if (m.locationMessage) {
    const l = m.locationMessage
    return `[El cliente compartió su ubicación: ${[l.name, l.address].filter(Boolean).join(', ')} — https://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}]`
  }
  if (m.contactMessage) return '[El cliente compartió un contacto: ' + (m.contactMessage.displayName || '') + ']'
  if (m.stickerMessage) return '[sticker]'
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText
  if (m.listResponseMessage?.title) return m.listResponseMessage.title
  return null
}

/** Detecta si el mensaje viene de un anuncio "clic a WhatsApp" de Meta */
export function datosDeAnuncio (mensaje) {
  const m = desenvolver(mensaje)
  for (const v of Object.values(m)) {
    const ci = v && typeof v === 'object' ? v.contextInfo : null
    if (!ci) continue
    const fuente = `${ci.conversionSource || ''} ${ci.entryPointConversionSource || ''} ${ci.entryPointConversionApp || ''}`
    if (ci.externalAdReply || ci.ctwaPayload || /ad|ctwa/i.test(fuente)) {
      const ad = ci.externalAdReply || {}
      return {
        esAnuncio: true,
        titulo: [ad.title, ad.body].filter(Boolean).join(' — ').slice(0, 200),
        id: ad.sourceType === 'ad' && ad.sourceId ? String(ad.sourceId) : '',
        url: ad.sourceUrl || '',
        // todo el texto del anuncio, para reconocer la zona y la promoción por sus palabras
        texto: [ad.title, ad.body, ad.sourceUrl, ad.greetingMessageBody, ad.ref].filter(Boolean).join(' ')
      }
    }
  }
  return { esAnuncio: false }
}

/**
 * Lee el mensaje que manda el botón «Reclamar premio», por ejemplo:
 * "🎁 Gané: Chocolatera · Código SE-4F7K"
 */
export function leerRegalo (texto) {
  const t = String(texto || '')
  // solo el mensaje del botón: trae 🎁 o un código, no una frase cualquiera con "gané"
  if (!/🎁/.test(t) && !/c[oó]digo\s*[:#]?\s*[A-Z0-9]/i.test(t)) return null
  const premio = t.match(/gan[eé]\s*[:\-]?\s*([^·|\n]+?)(?=\s*(?:[·|\n]|c[oó]digo|$))/i)
  if (!premio) return null
  const codigo = t.match(/c[oó]digo\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,24})/i)
  const nombre = premio[1].replace(/^(un|una|el|la)\s+/i, '').replace(/[.,;:!¡\s]+$/, '').trim()
  if (!nombre || nombre.length > 80 || !/[a-záéíóúñ]{3}/i.test(nombre)) return null
  return { nombre, codigo: codigo ? codigo[1].toUpperCase() : '' }
}

function tieneFraseClave (texto) {
  const t = (texto || '').toLowerCase()
  return (ajustes.frasesClave || []).some(f => t.includes(f.toLowerCase()))
}

/**
 * Campos del chat que salen del anuncio: zona y promoción si sus palabras las delatan.
 * Busca en el texto del anuncio y también en el primer mensaje (el mensaje prellenado del anuncio),
 * porque el nombre interno de la campaña en el Administrador de anuncios no llega por WhatsApp.
 */
function datosAnuncio (anuncio, primerMensaje = '') {
  const texto = (anuncio.texto || '') + ' ' + primerMensaje
  const z = anuncio.esAnuncio ? zonaDesdeAnuncio(texto) : null
  const o = ofertaDesde({ texto, zonaId: z?.id || '', esAnuncio: anuncio.esAnuncio })
  return {
    ...(anuncio.esAnuncio ? { anuncio: anuncio.titulo || '', anuncioId: anuncio.id || '', anuncioUrl: anuncio.url || '' } : {}),
    ...(z ? { zona: z.id, zonaFuente: 'anuncio' } : {}),
    ...(o ? { oferta: o.id } : {})
  }
}

const pausa = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * @param {object} io
 * @param {(jid:string, texto:string)=>Promise<void>} io.enviarTexto
 * @param {(jid:string, activo:boolean)=>Promise<void>} io.escribiendo
 * @param {(texto:string, extras?:string[], grupos?:string[])=>Promise<void>} io.avisar  aviso a Tomás y, si se pasan, a otros números y grupos
 * @param {(id:string)=>boolean} io.esIdDelBot
 * @param {(jid:string)=>boolean} io.esChatPropio
 * @param {(msg:object)=>Promise<string>} [io.transcribir]  nota de voz → texto ('' si no se pudo)
 * @param {()=>boolean} [io.conectado]
 */
export function crearManejador (io) {
  const avisarDueno = (texto) => io.avisar(texto, [], [])
  /**
   * Aviso a Tomás y a la zona del chat (números y grupo, p. ej. "APC Millenium").
   * Las citas por Meet las atiende Tomás: esas solo le llegan a él.
   */
  const avisarZona = (chat, texto, { modalidad } = {}) => {
    const zona = zonaPorId(chat?.zona)
    if (modalidad === 'meet') return io.avisar(texto, [], [])
    return io.avisar(texto, numerosDeZona(zona), gruposDeZona(zona))
  }
  const modalidadTexto = (c) => c.modalidad === 'meet'
    ? `📹 Google Meet${c.meetEnlace ? ' — ' + c.meetEnlace : ' — falta el enlace, envíaselo antes de la cita'} (regalo: se envía a su casa después)`
    : `🏠 Presencial — 📍 ${c.direccion}`
  const tel = (chat, jid) => chat?.telefono || digitos(jid)
  const etiquetaZona = (chat) => {
    const z = zonaPorId(chat?.zona)
    const lugar = [chat?.ciudad, chat?.estadoUS ? nombreEstado(chat.estadoUS) : '', chat?.codigoPostal].filter(Boolean).join(', ')
    if (z) {
      const detalle = lugar ? ` (${lugar})` : (chat.zonaFuente === 'anuncio' ? ' (según el anuncio; falta confirmar su ciudad)' : '')
      return `📍 ${z.nombre || z.id}${detalle} — atiende ${quienAtiende(z)}`
    }
    if (lugar) return hayZonas() ? `📍 ${lugar} — fuera de tus zonas` : `📍 ${lugar}`
    return '📍 Zona por confirmar'
  }
  const etiquetaOferta = (chat) => {
    const o = ofertaPorId(chat?.oferta)
    return o ? `\n🎁 Promoción: ${o.nombre}${chat.ofertaNoAplica ? ' (no aplica donde vive)' : ''}` : ''
  }
  const crmAhora = () => procesarColaCrm(avisarDueno).catch(e => console.error('Cola CRM:', e.message))

  const temporizadores = new Map()
  const ocupados = new Set()
  const pendientes = new Set()
  const ultimoAvisoError = new Map()
  const porLeer = new Map() // jid -> keys de mensajes aún sin "visto"

  function programarRespuesta (jid, segundos) {
    clearTimeout(temporizadores.get(jid))
    // espera base + un poco de variación al azar, como una persona que no contesta siempre al mismo segundo
    const variacion = Math.random() * (ajustes.variacionEsperaSegundos ?? 6)
    const espera = (segundos ?? ((ajustes.esperaAntesDeResponderSegundos ?? 7) + variacion)) * 1000
    temporizadores.set(jid, setTimeout(() => contestar(jid), espera))
  }

  /** Manda texto en burbujas, con pausas de escritura como una persona */
  async function enviarBurbujas (jid, texto, max = 3) {
    const burbujas = texto.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, max)
    for (const b of burbujas) {
      await io.escribiendo(jid, true)
      if (ajustes.simularEscritura !== false) {
        const ms = (1200 + b.length * 40) * (0.8 + Math.random() * 0.4)
        await pausa(Math.min(ms, 8000))
      }
      await io.enviarTexto(jid, b)
    }
  }

  /** Resumen para Tomás cuando toma un chat (desde el teléfono o desde la app) */
  async function avisarResumen (jid, como) {
    const chat = obtenerChat(jid)
    if (!chat || chat.historial.filter(h => h.rol === 'cliente').length < 2) return
    try {
      const texto = await resumir(jid)
      if (!texto) return
      crearOActualizarChat(jid, { resumen: { texto, t: Date.now() } })
      await avisarDueno(`📋 *Resumen de ${chat.nombreReal || chat.nombre || 'este chat'}* (${como}; Sofía queda en pausa)\n${texto}\n📱 ${numeroBonito(tel(chat, jid))}`)
    } catch (e) {
      console.error('No pude hacer el resumen', jid, e.message)
    }
  }

  async function contestar (jid) {
    temporizadores.delete(jid)
    if (ocupados.has(jid)) { pendientes.add(jid); return }
    ocupados.add(jid)
    try {
      const chat = obtenerChat(jid)
      if (!chat || chat.estado !== 'prospecto' || !botActivo()) return
      const ultimo = chat.historial[chat.historial.length - 1]
      if (!ultimo || ultimo.rol !== 'cliente') return
      // sin conexión con WhatsApp: no se pierde, se reintenta en 30 s
      if (io.conectado && !io.conectado()) { programarRespuesta(jid, 30); return }

      const n = contarRespuesta(jid, ahora().toISODate())
      if (n > (ajustes.maxRespuestasPorChatAlDia || 40)) {
        crearOActualizarChat(jid, { estado: 'humano' })
        await avisarZona(chat, `⚠️ El bot dejó de contestar a ${chat.nombre || ''} (${numeroBonito(tel(chat, jid))}) porque llegó al límite de mensajes del día. Revisa ese chat.`)
        return
      }

      // primero "lee" (palomitas azules), se toma un momento y luego empieza a escribir
      const llaves = porLeer.get(jid) || []
      porLeer.delete(jid)
      if (llaves.length && ajustes.marcarComoLeido !== false) {
        try { await io.marcarLeido?.(llaves) } catch {}
        if (ajustes.simularEscritura !== false) await pausa(1000 + Math.random() * 2500)
      }

      await io.escribiendo(jid, true)
      const r = await responder(jid)

      // si Tomás intervino mientras la IA pensaba, no se envía nada… pero lo que ya hicieron las
      // herramientas (cita, cancelación, etc.) igual se avisa y se pasa al CRM
      const despues = obtenerChat(jid)
      const enviar = despues.estado === 'prospecto' || r.humano
      try {
        if (enviar && r.texto) {
          await enviarBurbujas(jid, r.texto)
          agregarAlHistorial(jid, 'bot', r.texto)
        }
        if (enviar && r.experiencia) {
          // el enlace de la promoción va tal cual, en su propio mensaje, para que salga exacto
          await io.escribiendo(jid, true)
          if (ajustes.simularEscritura !== false) await pausa(2500)
          await io.enviarTexto(jid, r.experiencia)
          agregarAlHistorial(jid, 'bot', r.experiencia)
          crearOActualizarChat(jid, { experienciaEnviada: Date.now() })
          marcarAvance(jid, 'experiencia', 'Experiencia enviada')
        } else if (r.experiencia) {
          r.experiencia = null // no salió: Sofía podrá mandarlo después
        }
      } finally {
        await io.escribiendo(jid, false).catch(() => {})
        crearOActualizarChat(jid, { seguimiento: null })
        await despuesDeResponder(jid, r)
      }
    } catch (e) {
      console.error('Error al contestar', jid, e)
      try { await io.escribiendo(jid, false) } catch {}
      const ult = ultimoAvisoError.get(jid) || 0
      if (Date.now() - ult > 3600_000) {
        ultimoAvisoError.set(jid, Date.now())
        const chat = obtenerChat(jid)
        await avisarDueno(`❌ El bot no pudo contestar a ${chat?.nombre || ''} (${numeroBonito(chat?.telefono || digitos(jid))}). Error: ${String(e.message).slice(0, 150)}. Contéstale tú.`).catch(() => {})
      }
    } finally {
      ocupados.delete(jid)
      if (pendientes.delete(jid)) programarRespuesta(jid)
    }
  }

  /** Avisos y CRM según lo que pasó en la respuesta */
  async function despuesDeResponder (jid, r) {
    let crm = false
    if (r.ubicacion) {
      const ch = obtenerChat(jid)
      if (r.ubicacion.zonaNueva !== r.ubicacion.zonaAnterior || !ch.avisoUbicacion) {
        crearOActualizarChat(jid, { avisoUbicacion: Date.now(), zonaFuente: 'cliente' })
        await avisarZona(ch, `🧭 *${ch.nombre || 'Prospecto'}* dijo dónde vive\n${etiquetaZona(ch)}${etiquetaOferta(ch)}\n📱 ${numeroBonito(tel(ch, jid))}`)
      }
      if (r.ubicacion.fueraDeOferta && !ch.avisoFueraDeOferta) {
        crearOActualizarChat(jid, { avisoFueraDeOferta: Date.now() })
        await avisarDueno(`⚠️ *${ch.nombre || 'Un prospecto'}* llegó por "${r.ubicacion.fueraDeOferta}" pero vive en ${[ch.ciudad, nombreEstado(ch.estadoUS)].filter(Boolean).join(', ') || 'otro estado'}.\n${zonaPorId(ch.zona) ? 'Sofía sigue con la cita normal (sin la promoción).' : 'Sofía le dijo que confirmas disponibilidad con el equipo.'}\n📱 ${numeroBonito(tel(ch, jid))}`).catch(() => {})
      }
      sincronizarProspecto(jid)
      crm = true
    }
    if (r.aceptoDemo || r.experiencia) { sincronizarEstado(jid, 'progress'); crm = true }
    if (r.cancelada) {
      const c = r.cancelada
      const ch = obtenerChat(jid)
      await avisarZona(ch,
        `❌ *${c.nombre} canceló su cita*\nEra: ${formatoCita(c)}\n${modalidadTexto(c)}\nDijo: "${String(c.motivo).slice(0, 160)}"\n📱 ${numeroBonito(c.telefono || digitos(jid))}`,
        { modalidad: c.modalidad })
      sincronizarEstado(jid, 'appointment_cancelled', { appointment: citaParaCrm(c, formatoCita(c)) })
      crm = true
    }
    if (r.reprogramada) {
      const { anterior, nueva, motivo } = r.reprogramada
      const ch = obtenerChat(jid)
      // si cambió de presencial a Meet (o al revés), avisa a ambos lados
      const modalidad = anterior.modalidad === 'meet' && nueva.modalidad === 'meet' ? 'meet' : 'presencial'
      await avisarZona(ch,
        `🔁 *${nueva.nombre} cambió su cita*\nAntes: ${formatoCita(anterior)}\nAhora: ${formatoCita(nueva)}\n${modalidadTexto(nueva)}` +
        `\n👤 Atiende: ${nueva.atiende}` + (motivo ? `\nDijo: "${String(motivo).slice(0, 160)}"` : '') +
        `\n📱 ${numeroBonito(nueva.telefono || digitos(jid))}`,
        { modalidad })
      if (r.errorCalendario) await avisarDueno(`⚠️ La nueva cita de ${nueva.nombre} quedó guardada, pero no pude crearla en Google Calendar: ${r.errorCalendario}`).catch(() => {})
      sincronizarEstado(jid, 'appointment_rescheduled', {
        appointment: citaParaCrm(nueva, formatoCita(nueva)),
        previousRef: anterior.id,
        schedulePreference: `Cita (${nueva.modalidad === 'meet' ? 'Google Meet' : 'presencial'}): ${formatoCita(nueva)}`.slice(0, 240)
      })
      crm = true
    }
    if (r.cita) {
      const c = r.cita
      const ch = obtenerChat(jid)
      await avisarZona(ch,
        `🗓️ *Nueva cita agendada*\n${c.nombre}\n${formatoCita(c)}\n${modalidadTexto(c)}` +
        `\n👤 Atiende: ${c.atiende}` +
        `\n📱 ${numeroBonito(c.telefono || digitos(jid))}` + (c.notas ? `\n📝 ${c.notas}` : '') +
        `\n${etiquetaZona(ch)}` + etiquetaOferta(ch) + (ch.anuncio ? `\n📢 ${ch.anuncio}` : ''),
        { modalidad: c.modalidad })
      if (r.errorCalendario) await avisarDueno(`⚠️ La cita de ${c.nombre} quedó guardada, pero no pude crearla en Google Calendar: ${r.errorCalendario}`).catch(() => {})
      sincronizarEstado(jid, 'appointment_scheduled', {
        appointment: citaParaCrm(c, formatoCita(c)),
        schedulePreference: `Cita (${c.modalidad === 'meet' ? 'Google Meet' : 'presencial'}): ${formatoCita(c)}`.slice(0, 240)
      })
      crm = true
    }
    if (r.confirmada) {
      const c = r.confirmada
      await avisarZona(obtenerChat(jid), `✅ *${c.nombre} confirmó su cita*\n${formatoCita(c)}\n${modalidadTexto(c)}`, { modalidad: c.modalidad })
      sincronizarEstado(jid, 'appointment_confirmed', { appointment: citaParaCrm(c, formatoCita(c)) })
      crm = true
    }
    if (r.noInteresado) {
      const ch = obtenerChat(jid)
      await avisarDueno(`🚫 ${ch.nombreReal || ch.nombre || 'Un prospecto'} dijo que no le interesa. No se le harán seguimientos.\nDijo: "${String(r.noInteresado.motivo).slice(0, 140)}"\n📱 ${numeroBonito(tel(ch, jid))}`).catch(() => {})
      sincronizarEstado(jid, 'not_interested')
      crm = true
    }
    if (r.humano) {
      crearOActualizarChat(jid, { estado: 'humano', resumen: { texto: r.humano.resumen, t: Date.now() } })
      const ch = obtenerChat(jid)
      await avisarZona(ch,
        `🙋 *Un prospecto necesita que le escribas tú*\n${ch.nombre || ''} — ${numeroBonito(tel(ch, jid))}` +
        `\nMotivo: ${r.humano.motivo}\nResumen: ${r.humano.resumen}\n${etiquetaZona(ch)}${etiquetaOferta(ch)}`
      )
    }
    if (crm) crmAhora()
  }

  /** Procesa un mensaje de messages.upsert ('notify' = nuevo; 'append' = llegó mientras estabas desconectado u otro dispositivo) */
  async function procesar (msg, tipoUpsert) {
    const jid = msg.key?.remoteJid
    if (esGrupoOEspecial(jid) || !msg.message) return
    let texto = leerContenido(msg.message)
    if (texto == null) return
    if (tipoUpsert !== 'notify' && tipoUpsert !== 'append') return
    // WhatsApp puede reenviar el mismo mensaje al reconectar: cada uno se procesa una sola vez
    if (yaProcesado(msg.key.id)) return
    const segundos = Number(msg.messageTimestamp || 0)
    const cuando = segundos ? Math.min(segundos * 1000, Date.now()) : Date.now()

    // ---- Mensajes enviados desde tu número ----
    if (msg.key.fromMe) {
      if (io.esIdDelBot(msg.key.id) || io.esChatPropio(jid)) return
      if (esAudio(msg.message)) texto = '[Tomás envió una nota de voz]'
      const chat = obtenerChat(jid)
      if (!chat) { crearOActualizarChat(jid, { estado: 'conocido' }); return }
      const tomaba = chat.estado === 'prospecto'
      if (tomaba) {
        const horas = ajustes.pausaAlIntervenirHoras ?? 24
        crearOActualizarChat(jid, { estado: 'pausado', pausadoHasta: Date.now() + horas * 3600_000, seguimiento: null })
        clearTimeout(temporizadores.get(jid))
        console.log(`Tomás intervino en ${jid}: bot en pausa ${horas} h`)
      }
      if (['prospecto', 'pausado', 'humano'].includes(obtenerChat(jid).estado)) agregarAlHistorial(jid, 'tomas', texto, cuando)
      if (tomaba && tipoUpsert === 'notify') avisarResumen(jid, 'escribiste en el chat')
      return
    }

    // ---- Mensajes que te llegan ----
    if (Date.now() - cuando > (ajustes.edadMaximaMensajeHoras ?? 24) * 3600_000) return

    const alt = msg.key.remoteJidAlt
    const telefono = digitos(alt && alt.endsWith('@s.whatsapp.net') ? alt : (jid.endsWith('@s.whatsapp.net') ? jid : ''))
    const anuncio = datosDeAnuncio(msg.message)
    let chat = obtenerChat(jid)
    // 'append' solo continúa chats que ya atendemos o trae un anuncio: nunca convierte chats viejos en prospectos
    if (tipoUpsert === 'append' && !anuncio.esAnuncio && !(chat && ['prospecto', 'pausado'].includes(chat.estado))) return
    let nuevoProspecto = false
    const base = { nombre: msg.pushName || chat?.nombre || '', telefono: telefono || chat?.telefono || '' }

    if (!chat) {
      const modo = ajustes.modoRespuesta || 'campanas'
      const esProspecto = modo === 'todos' || modo === 'nuevos' || anuncio.esAnuncio || tieneFraseClave(texto)
      chat = crearOActualizarChat(jid, {
        ...base,
        estado: esProspecto ? 'prospecto' : 'conocido',
        origen: anuncio.esAnuncio ? 'anuncio' : (esProspecto ? (modo === 'campanas' ? 'frase clave' : modo) : ''),
        ...(esProspecto ? datosAnuncio(anuncio, texto) : {})
      })
      if (esProspecto) { console.log(`Nuevo prospecto ${jid} (${chat.origen})`); nuevoProspecto = true }
    } else {
      const cambios = { ...base }
      if (chat.estado === 'conocido' && (anuncio.esAnuncio || ajustes.modoRespuesta === 'todos')) {
        cambios.estado = 'prospecto'
        cambios.origen = anuncio.esAnuncio ? 'anuncio' : 'todos'
        Object.assign(cambios, datosAnuncio(anuncio, texto))
        nuevoProspecto = true
      }
      if (chat.estado === 'pausado' && chat.pausadoHasta && Date.now() > chat.pausadoHasta) {
        cambios.estado = 'prospecto'
        cambios.pausadoHasta = null
      }
      chat = crearOActualizarChat(jid, cambios)
    }

    if (chat.estado === 'conocido') {
      // Un chat que ya tenías escribe una frase de interés: no se le contesta solo (puede ser un cliente),
      // pero te aviso y queda en la app como "Pide información" para activarlo con un toque.
      if (!tieneFraseClave(texto)) return
      if (ajustes.frasesActivanChatsConocidos === true) {
        chat = crearOActualizarChat(jid, { estado: 'prospecto', origen: 'frase clave', pideInfo: null, ...datosAnuncio(anuncio, texto) })
        nuevoProspecto = true
      } else {
        const yaAvisado = chat.pideInfo && Date.now() - chat.pideInfo < 6 * 3600_000
        crearOActualizarChat(jid, { pideInfo: Date.now() })
        agregarAlHistorial(jid, 'cliente', texto, cuando)
        if (!yaAvisado) {
          await avisarDueno(
            `💬 *${chat.nombre || 'Un contacto'}* (chat que ya tenías) escribió: "${texto.slice(0, 120)}"\n📱 ${numeroBonito(tel(chat, jid))}` +
            `\nEl bot no le contestó porque ya era un chat tuyo. Si quieres que lo atienda, ábrelo en la app (aparece como "Pide información") y toca "Que conteste el bot".`
          ).catch(e => console.error('Aviso pide info falló', e.message))
        }
        return
      }
    }

    // nota de voz: se transcribe solo en los chats que Sofía atiende (o que tú tomaste)
    if (esAudio(msg.message) && ['prospecto', 'pausado', 'humano'].includes(chat.estado)) {
      let t = ''
      if (ajustes.transcribirAudios !== false && io.transcribir) {
        try { t = (await io.transcribir(msg)) || '' } catch (e) { console.error('No pude transcribir', jid, e.message) }
      }
      if (t) texto = `[Nota de voz del cliente, transcrita]: ${t}`
    }

    agregarAlHistorial(jid, 'cliente', texto, cuando)
    // si escribe, se reinician los seguimientos
    if (chat.seguimiento) crearOActualizarChat(jid, { seguimiento: null })

    // regreso desde «Reclamar premio»: mismo prospecto, se registra el regalo
    const regalo = chat.oferta ? leerRegalo(texto) : null
    if (regalo) await registrarRegalo(jid, regalo)

    if (nuevoProspecto) {
      marcarAvance(jid, 'inicio', 'Conversación iniciada')
      const ch = obtenerChat(jid)
      if (ajustes.avisarNuevoProspecto !== false) {
        await avisarZona(ch,
          `📣 *Nuevo prospecto de campaña*\n${ch.nombre || 'Sin nombre'} — ${numeroBonito(tel(ch, jid))}` +
          `\n📢 ${ch.origen === 'anuncio' ? 'Anuncio: ' + (ch.anuncio || 'sin título') : 'Escribió: "' + texto.slice(0, 80) + '"'}` +
          `\n${etiquetaZona(ch)}${etiquetaOferta(ch)}`
        ).catch(e => console.error('Aviso de nuevo prospecto falló', e.message))
      }
      if (ch.zona) { sincronizarProspecto(jid); crmAhora() }
    }
    if (chat.estado === 'prospecto' && botActivo()) {
      porLeer.set(jid, [...(porLeer.get(jid) || []), msg.key].slice(-20))
      programarRespuesta(jid)
    }
  }

  /** Guarda el regalo del juego (una participación por persona) y avisa */
  async function registrarRegalo (jid, regalo) {
    const chat = obtenerChat(jid)
    const o = ofertaPorId(chat.oferta)
    if (chat.regalo && chat.regalo.codigo && regalo.codigo && chat.regalo.codigo !== regalo.codigo) {
      await avisarDueno(`⚠️ ${chat.nombre || 'Un prospecto'} mandó un segundo premio de "${o?.nombre || 'la promoción'}" (${regalo.nombre}, ${regalo.codigo}); ya tenía ${chat.regalo.nombre} (${chat.regalo.codigo}). Se queda el primero.\n📱 ${numeroBonito(tel(chat, jid))}`).catch(() => {})
      return
    }
    if (chat.regalo && (!regalo.codigo || chat.regalo.codigo === regalo.codigo)) return
    const usadoPor = regalo.codigo ? registrarCodigoRegalo(regalo.codigo, jid) : null
    crearOActualizarChat(jid, { regalo: { ...regalo, t: Date.now(), ...(usadoPor ? { duplicado: usadoPor } : {}) } })
    marcarAvance(jid, 'regalo', 'Regalo revelado')
    const ch = obtenerChat(jid)
    const cita = citasVigentes(jid)[0]
    await avisarZona(ch,
      `🎁 *${ch.nombreReal || ch.nombre || 'Prospecto'} descubrió su regalo*: ${regalo.nombre}${regalo.codigo ? ` (código ${regalo.codigo})` : ''}` +
      (usadoPor ? `\n⚠️ Ese código ya lo había usado otro número (${numeroBonito(obtenerChat(usadoPor)?.telefono || digitos(usadoPor))}). Revísalo.` : '') +
      `\n${cita ? '🗓️ Cita: ' + formatoCita(cita) : 'Todavía sin cita'}\n📱 ${numeroBonito(tel(ch, jid))}`,
      { modalidad: cita?.modalidad }).catch(() => {})
    sincronizarEstado(jid, 'progress')
    crmAhora()
  }

  /** Al vincular, WhatsApp manda tus chats existentes: se marcan como "conocidos" para no contestarles */
  function historialInicial (chats) {
    const ids = (chats || []).map(c => c.id).filter(id => !esGrupoOEspecial(id))
    const n = marcarConocidos(ids)
    if (n) console.log(`${n} chats existentes marcados como conocidos (el bot no les contestará)`)
  }

  /** Cuando activas un chat desde la app: si el último mensaje es del cliente, el bot contesta ya */
  function contestarAhora (jid) {
    const chat = obtenerChat(jid)
    const ultimo = chat?.historial?.[chat.historial.length - 1]
    if (chat?.estado === 'prospecto' && ultimo?.rol === 'cliente' && botActivo()) programarRespuesta(jid)
  }

  /** Cuando tomas un chat desde la app (Pausar): Sofía se calla y te llega el resumen */
  function tomarChat (jid) {
    const chat = obtenerChat(jid)
    if (!chat) return
    const estabaActivo = chat.estado === 'prospecto'
    clearTimeout(temporizadores.get(jid))
    crearOActualizarChat(jid, { estado: 'pausado', pausadoHasta: null, seguimiento: null })
    if (estabaActivo) avisarResumen(jid, 'lo tomaste desde la app')
  }

  /**
   * Recordatorio del día anterior (a la hora de ajustes.recordatorio.hora, en la hora local del cliente)
   * y aviso a Tomás si el cliente no contesta. Se llama cada pocos minutos desde whatsapp.js.
   */
  async function revisarRecordatorios () {
    const conf = ajustes.recordatorio || {}
    if (conf.activo === false) return
    const [hh, mm] = String(conf.hora || '12:00').split(':').map(Number)
    const horasSinRespuesta = conf.avisarSinRespuestaHoras ?? 5
    const ahoraMs = Date.now()
    for (const c of listarCitas()) {
      if (c.estado !== 'agendada' || Date.parse(c.inicio) <= ahoraMs) continue
      const tz = c.tzCliente || c.zonaHoraria
      const inicio = DateTime.fromISO(c.inicio).setZone(tz)
      const momento = inicio.minus({ days: 1 }).set({ hour: hh, minute: mm || 0, second: 0, millisecond: 0 })
      const chat = obtenerChat(c.chatId)

      // 1) enviar el recordatorio
      if (!c.recordatorio && ahoraMs >= +momento && (c.creada || 0) < +momento && ahoraMs < Date.parse(c.inicio) - 2 * 3600_000) {
        const nombre = String(c.nombre || '').split(' ')[0]
        const cuando = formatoHumano(inicio) // "jueves 23 de octubre, 3:00 p. m."
        const donde = c.modalidad === 'meet'
          ? `por Google Meet${c.meetEnlace ? `. Este es el enlace: ${c.meetEnlace}` : ' (te enviaremos el enlace)'}`
          : `en tu casa (${c.direccion})`
        const regalo = chat?.regalo && !chat.regalo.duplicado
          ? `Recuerda que tienes tu ${chat.regalo.nombre} 🎁`
          : 'Recuerda que tienes un regalo premium para tu cocina 🎁'
        const texto = `¡Hola${nombre ? ' ' + nombre : ''}! Soy Sofía, del equipo de ${equipoDe(zonaPorId(c.zona))} 😊 Te escribo para confirmar tu cita de mañana, ${cuando}, ${donde}.\n\n¿Nos confirmas que todo sigue en pie? ${regalo}`
        try {
          await io.enviarTexto(c.chatId, texto)
          if (chat) agregarAlHistorial(c.chatId, 'bot', texto)
          actualizarCita(c.id, { recordatorio: { enviado: Date.now() } })
          await avisarZona(chat || { zona: c.zona }, `⏰ Recordatorio enviado a ${c.nombre} para su cita de ${formatoCita(c)} (${c.modalidad === 'meet' ? 'Meet' : 'presencial'}).`, { modalidad: c.modalidad })
        } catch (e) {
          console.error('No pude enviar el recordatorio', c.id, e.message)
        }
        continue
      }

      // 2) avisar si no contestó
      if (c.recordatorio && !c.confirmacion && !c.recordatorio.avisoSinRespuesta &&
          ahoraMs >= c.recordatorio.enviado + horasSinRespuesta * 3600_000) {
        actualizarCita(c.id, { recordatorio: { ...c.recordatorio, avisoSinRespuesta: Date.now() } })
        await avisarZona(chat || { zona: c.zona },
          `⚠️ *${c.nombre} no ha confirmado* su cita de ${formatoCita(c)} (${c.modalidad === 'meet' ? 'Meet' : 'presencial'}).\n📱 ${numeroBonito(c.telefono || digitos(c.chatId))}`,
          { modalidad: c.modalidad }).catch(() => {})
      }
    }
  }

  /**
   * Seguimiento a quien no agendó y dejó de contestar: a las 24 h y a los 3 días de su último mensaje
   * (ajustes.seguimiento.horas), solo en horario razonable de su zona. Se detiene si dijo que no,
   * si agendó, si Tomás intervino o si el chat no está a cargo de Sofía.
   */
  async function revisarSeguimientos () {
    const conf = ajustes.seguimiento || {}
    if (conf.activo === false || !botActivo()) return
    if (io.conectado && !io.conectado()) return
    const horas = Array.isArray(conf.horas) && conf.horas.length ? conf.horas : [24, 72]
    const [dh, dm] = String(conf.desde || '10:00').split(':').map(Number)
    const [hh, hm] = String(conf.hasta || '19:00').split(':').map(Number)
    for (const chat of listarChats()) {
      if (chat.estado !== 'prospecto' || chat.noInteresado || ocupados.has(chat.id) || temporizadores.has(chat.id)) continue
      const citasChat = listarCitas().filter(c => c.chatId === chat.id)
      if (citasChat.some(c => c.estado === 'agendada')) continue
      // canceló su cita y no pidió otra: no se le insiste
      if (citasChat.some(c => c.estado === 'cancelada' && !c.reprogramadaA)) continue
      const ult = chat.historial[chat.historial.length - 1]
      const ultCliente = [...chat.historial].reverse().find(h => h.rol === 'cliente')
      if (!ult || !ultCliente || ult.rol !== 'bot') continue // solo si Sofía fue la última en escribir
      const hechos = chat.seguimiento?.n || 0
      if (hechos >= horas.length) continue
      if (Date.now() - ultCliente.t < horas[hechos] * 3600_000) continue
      const local = DateTime.now().setZone(tzDelCliente(chat))
      const minutos = local.hour * 60 + local.minute
      if (minutos < dh * 60 + (dm || 0) || minutos > hh * 60 + (hm || 0)) continue
      ocupados.add(chat.id)
      try {
        const r = await responder(chat.id, { seguimiento: hechos + 1 })
        const ahoraChat = obtenerChat(chat.id)
        if (!r.texto || ahoraChat.estado !== 'prospecto' || ahoraChat.historial.at(-1)?.t !== ult.t) continue
        await enviarBurbujas(chat.id, r.texto, 2)
        await io.escribiendo(chat.id, false)
        agregarAlHistorial(chat.id, 'bot', r.texto)
        crearOActualizarChat(chat.id, { seguimiento: { n: hechos + 1, t: Date.now() } })
        console.log(`Seguimiento ${hechos + 1} enviado a ${chat.id}`)
      } catch (e) {
        console.error('No pude enviar el seguimiento', chat.id, e.message)
      } finally {
        ocupados.delete(chat.id)
      }
    }
  }

  /** Revisión periódica: recordatorios, seguimientos y cola del CRM */
  async function revisarTodo () {
    await revisarRecordatorios().catch(e => console.error('Recordatorios:', e.message))
    await revisarSeguimientos().catch(e => console.error('Seguimientos:', e.message))
    await procesarColaCrm(avisarDueno).catch(e => console.error('Cola CRM:', e.message))
  }

  return { procesar, historialInicial, contestar, contestarAhora, tomarChat, revisarRecordatorios, revisarSeguimientos, revisarTodo }
}
