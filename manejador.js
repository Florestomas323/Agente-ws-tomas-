// Decide a qué mensajes contestar, cuándo callarse y cuándo avisarte.
// No depende de Baileys directamente: recibe funciones para enviar (así se puede probar sin WhatsApp).
import { ajustes } from './config.js'
import { responder } from './agente.js'
import { ahora, formatoCita } from './calendario.js'
import {
  obtenerChat, crearOActualizarChat, agregarAlHistorial, contarRespuesta, botActivo, marcarConocidos
} from './almacen.js'
import { zonaDesdeAnuncio, zonaPorId, numerosDeZona, nombreEstado, hayZonas, quienAtiende } from './zonas.js'
import { enviarAlCrm, crmConfigurado } from './crm.js'

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

/** Saca el texto legible de un mensaje de WhatsApp (o una descripción si no es texto) */
export function leerContenido (mensaje) {
  const m = desenvolver(mensaje)
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage) return '[El cliente envió una foto]' + (m.imageMessage.caption ? ' ' + m.imageMessage.caption : '')
  if (m.videoMessage) return '[El cliente envió un video]' + (m.videoMessage.caption ? ' ' + m.videoMessage.caption : '')
  if (m.audioMessage) return '[El cliente envió una nota de voz que no puedes escuchar]'
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
        // todo el texto del anuncio, para reconocer la zona por sus palabras
        texto: [ad.title, ad.body, ad.sourceUrl, ad.greetingMessageBody, ad.ref].filter(Boolean).join(' ')
      }
    }
  }
  return { esAnuncio: false }
}

function tieneFraseClave (texto) {
  const t = (texto || '').toLowerCase()
  return (ajustes.frasesClave || []).some(f => t.includes(f.toLowerCase()))
}

/**
 * Campos del chat que salen del anuncio, incluida la zona si sus palabras la delatan.
 * Busca en el texto del anuncio y también en el primer mensaje (el mensaje prellenado del anuncio),
 * porque el nombre interno de la campaña en el Administrador de anuncios no llega por WhatsApp.
 */
function datosAnuncio (anuncio, primerMensaje = '') {
  if (!anuncio.esAnuncio) return {}
  const z = zonaDesdeAnuncio(anuncio.texto + ' ' + primerMensaje)
  return {
    anuncio: anuncio.titulo || '',
    anuncioId: anuncio.id || '',
    anuncioUrl: anuncio.url || '',
    ...(z ? { zona: z.id, zonaFuente: 'anuncio' } : {})
  }
}

const pausa = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * @param {object} io
 * @param {(jid:string, texto:string)=>Promise<void>} io.enviarTexto
 * @param {(jid:string, activo:boolean)=>Promise<void>} io.escribiendo
 * @param {(texto:string, extras?:string[])=>Promise<void>} io.avisar  aviso a Tomás y, si se pasan, a otros números
 * @param {(id:string)=>boolean} io.esIdDelBot
 * @param {(jid:string)=>boolean} io.esChatPropio
 */
export function crearManejador (io) {
  const avisarDueno = (texto) => io.avisar(texto, [])
  /** Aviso a Tomás y a quien atiende la zona del chat */
  const avisarZona = (chat, texto) => io.avisar(texto, numerosDeZona(zonaPorId(chat?.zona)))
  const tel = (chat, jid) => chat?.telefono || digitos(jid)
  const etiquetaZona = (chat) => {
    const z = zonaPorId(chat?.zona)
    const lugar = [chat?.ciudad, chat?.estadoUS ? nombreEstado(chat.estadoUS) : ''].filter(Boolean).join(', ')
    if (z) {
      const detalle = lugar ? ` (${lugar})` : (chat.zonaFuente === 'anuncio' ? ' (según el anuncio; falta confirmar su ciudad)' : '')
      return `📍 ${z.nombre || z.id}${detalle} — atiende ${quienAtiende(z)}`
    }
    if (lugar) return hayZonas() ? `📍 ${lugar} — fuera de tus zonas` : `📍 ${lugar}`
    return '📍 Zona por confirmar'
  }

  /** Manda el chat al CRM de su zona (si está configurado) y avisa a Tomás si falla */
  async function alCrm (jid, extra = {}) {
    const chat = obtenerChat(jid)
    const zona = zonaPorId(chat?.zona)
    if (!chat || (hayZonas() && !zona) || !crmConfigurado(zona)) return
    const r = await enviarAlCrm(chat, zona, extra)
    if (r.ok) {
      crearOActualizarChat(jid, { crm: { zona: zona?.id || '', id: r.id, enviado: Date.now() } })
      console.log(`CRM ${zona?.id || 'general'} ← ${jid} (${r.duplicado ? 'actualizado' : 'nuevo'})`)
    } else if (!r.omitido) {
      console.error('CRM falló', jid, r.error)
      await avisarDueno(`⚠️ No pude mandar a ${chat.nombre || ''} (wa.me/${tel(chat, jid)}) al CRM de ${zona?.nombre || 'la zona'}: ${r.error}`).catch(() => {})
    }
  }
  const temporizadores = new Map()
  const ocupados = new Set()
  const pendientes = new Set()
  const ultimoAvisoError = new Map()

  const porLeer = new Map() // jid -> keys de mensajes aún sin "visto"

  function programarRespuesta (jid) {
    clearTimeout(temporizadores.get(jid))
    // espera base + un poco de variación al azar, como una persona que no contesta siempre al mismo segundo
    const variacion = Math.random() * (ajustes.variacionEsperaSegundos ?? 6)
    const espera = ((ajustes.esperaAntesDeResponderSegundos ?? 7) + variacion) * 1000
    temporizadores.set(jid, setTimeout(() => contestar(jid), espera))
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

      const n = contarRespuesta(jid, ahora().toISODate())
      if (n > (ajustes.maxRespuestasPorChatAlDia || 40)) {
        crearOActualizarChat(jid, { estado: 'humano' })
        await avisarZona(chat, `⚠️ El bot dejó de contestar a ${chat.nombre || ''} (wa.me/${tel(chat, jid)}) porque llegó al límite de mensajes del día. Revisa ese chat.`)
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

      // si Tomás intervino mientras la IA pensaba, no enviar nada
      const despues = obtenerChat(jid)
      if (despues.estado !== 'prospecto' && !r.humano) { await io.escribiendo(jid, false); return }

      if (r.texto) {
        const burbujas = r.texto.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 3)
        for (let i = 0; i < burbujas.length; i++) {
          await io.escribiendo(jid, true)
          if (ajustes.simularEscritura !== false) {
            // velocidad de escritura de una persona en el celular, con algo de variación
            const ms = (1200 + burbujas[i].length * 40) * (0.8 + Math.random() * 0.4)
            await pausa(Math.min(ms, 8000))
          }
          await io.enviarTexto(jid, burbujas[i])
        }
        agregarAlHistorial(jid, 'bot', r.texto)
      }
      await io.escribiendo(jid, false)

      if (r.ubicacion) {
        const ch = obtenerChat(jid)
        if (r.ubicacion.zonaNueva !== r.ubicacion.zonaAnterior || !ch.avisoUbicacion) {
          crearOActualizarChat(jid, { avisoUbicacion: Date.now(), zonaFuente: 'cliente' })
          await avisarZona(ch, `🧭 *${ch.nombre || 'Prospecto'}* dijo dónde vive\n${etiquetaZona(ch)}\n📱 wa.me/${tel(ch, jid)}`)
          await alCrm(jid)
        }
      }
      if (r.cita) {
        const c = r.cita
        const ch = obtenerChat(jid)
        await avisarZona(ch,
          `🗓️ *Nueva cita agendada*\n${c.nombre}\n${formatoCita(c)}\n📍 ${c.direccion}` +
          `\n📱 wa.me/${c.telefono || digitos(jid)}` + (c.notas ? `\n📝 ${c.notas}` : '') +
          `\n${etiquetaZona(ch)}` + (ch.anuncio ? `\n📢 ${ch.anuncio}` : '')
        )
        await alCrm(jid, { cita: c, citaTexto: formatoCita(c) })
      }
      if (r.humano) {
        crearOActualizarChat(jid, { estado: 'humano' })
        const ch = obtenerChat(jid)
        await avisarZona(ch,
          `🙋 *Un prospecto necesita que le escribas tú*\n${ch.nombre || ''} — wa.me/${tel(ch, jid)}` +
          `\nMotivo: ${r.humano.motivo}\nResumen: ${r.humano.resumen}\n${etiquetaZona(ch)}`
        )
      }
    } catch (e) {
      console.error('Error al contestar', jid, e)
      try { await io.escribiendo(jid, false) } catch {}
      const ult = ultimoAvisoError.get(jid) || 0
      if (Date.now() - ult > 3600_000) {
        ultimoAvisoError.set(jid, Date.now())
        const chat = obtenerChat(jid)
        await avisarDueno(`❌ El bot no pudo contestar a ${chat?.nombre || ''} (wa.me/${chat?.telefono || digitos(jid)}). Error: ${String(e.message).slice(0, 150)}. Contéstale tú.`).catch(() => {})
      }
    } finally {
      ocupados.delete(jid)
      if (pendientes.delete(jid)) programarRespuesta(jid)
    }
  }

  /** Procesa un mensaje de messages.upsert */
  async function procesar (msg, tipoUpsert) {
    const jid = msg.key?.remoteJid
    if (esGrupoOEspecial(jid) || !msg.message) return
    const texto = leerContenido(msg.message)
    if (texto == null) return

    // ---- Mensajes enviados desde tu número ----
    if (msg.key.fromMe) {
      if (io.esIdDelBot(msg.key.id) || io.esChatPropio(jid)) return
      const chat = obtenerChat(jid)
      if (!chat) { crearOActualizarChat(jid, { estado: 'conocido' }); return }
      if (chat.estado === 'prospecto') {
        const horas = ajustes.pausaAlIntervenirHoras ?? 24
        crearOActualizarChat(jid, { estado: 'pausado', pausadoHasta: Date.now() + horas * 3600_000 })
        clearTimeout(temporizadores.get(jid))
        console.log(`Tomás intervino en ${jid}: bot en pausa ${horas} h`)
      }
      if (['prospecto', 'pausado', 'humano'].includes(obtenerChat(jid).estado)) agregarAlHistorial(jid, 'tomas', texto)
      return
    }

    // ---- Mensajes que te llegan ----
    if (tipoUpsert !== 'notify') return
    const segundos = Number(msg.messageTimestamp || 0)
    if (segundos && Date.now() / 1000 - segundos > (ajustes.edadMaximaMensajeHoras ?? 3) * 3600) return

    const alt = msg.key.remoteJidAlt
    const telefono = digitos(alt && alt.endsWith('@s.whatsapp.net') ? alt : (jid.endsWith('@s.whatsapp.net') ? jid : ''))
    const anuncio = datosDeAnuncio(msg.message)
    let chat = obtenerChat(jid)
    let nuevoProspecto = false
    const base = { nombre: msg.pushName || chat?.nombre || '', telefono: telefono || chat?.telefono || '' }

    if (!chat) {
      const modo = ajustes.modoRespuesta || 'campanas'
      const esProspecto = modo === 'todos' || modo === 'nuevos' || anuncio.esAnuncio || tieneFraseClave(texto)
      chat = crearOActualizarChat(jid, {
        ...base,
        estado: esProspecto ? 'prospecto' : 'conocido',
        origen: anuncio.esAnuncio ? 'anuncio' : (esProspecto ? (modo === 'campanas' ? 'frase clave' : modo) : ''),
        ...datosAnuncio(anuncio, texto)
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
        chat = crearOActualizarChat(jid, { estado: 'prospecto', origen: 'frase clave', pideInfo: null })
        nuevoProspecto = true
      } else {
        const yaAvisado = chat.pideInfo && Date.now() - chat.pideInfo < 6 * 3600_000
        crearOActualizarChat(jid, { pideInfo: Date.now() })
        agregarAlHistorial(jid, 'cliente', texto)
        if (!yaAvisado) {
          await avisarDueno(
            `💬 *${chat.nombre || 'Un contacto'}* (chat que ya tenías) escribió: "${texto.slice(0, 120)}"\n📱 wa.me/${tel(chat, jid)}` +
            `\nEl bot no le contestó porque ya era un chat tuyo. Si quieres que lo atienda, ábrelo en la app (aparece como "Pide información") y toca "Que conteste el bot".`
          ).catch(e => console.error('Aviso pide info falló', e.message))
        }
        return
      }
    }
    agregarAlHistorial(jid, 'cliente', texto)

    if (nuevoProspecto) {
      const ch = obtenerChat(jid)
      if (ajustes.avisarNuevoProspecto !== false) {
        await avisarZona(ch,
          `📣 *Nuevo prospecto de campaña*\n${ch.nombre || 'Sin nombre'} — wa.me/${tel(ch, jid)}` +
          `\n📢 ${ch.origen === 'anuncio' ? 'Anuncio: ' + (ch.anuncio || 'sin título') : 'Escribió: "' + texto.slice(0, 80) + '"'}` +
          `\n${etiquetaZona(ch)}`
        ).catch(e => console.error('Aviso de nuevo prospecto falló', e.message))
      }
      if (ch.zona) await alCrm(jid)
    }
    if (chat.estado === 'prospecto' && botActivo()) {
      porLeer.set(jid, [...(porLeer.get(jid) || []), msg.key].slice(-20))
      programarRespuesta(jid)
    }
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

  return { procesar, historialInicial, contestar, contestarAhora }
}
