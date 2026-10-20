// Conexión con WhatsApp usando Baileys (como WhatsApp Web, vinculado a tu teléfono)
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'
import makeWASocket, {
  DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore, generateMessageIDV2, jidNormalizedUser, Browsers
} from 'baileys'
import { config, ajustes } from './config.js'
import { crearManejador } from './manejador.js'
import { obtenerChat, crearOActualizarChat, agregarAlHistorial } from './almacen.js'

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' })
const carpetaSesion = path.join(config.carpetaDatos, 'sesion-whatsapp')

export const estadoWA = {
  conectado: false,
  numero: '',
  codigoVinculacion: '',
  qrImagen: '',
  ultimoError: '',
  desde: null
}

let sock = null
const idsDelBot = new Set()
let reintentos = 0

function recordarId (id) {
  idsDelBot.add(id)
  if (idsDelBot.size > 5000) idsDelBot.delete(idsDelBot.values().next().value)
}

async function enviar (jid, contenido) {
  if (!sock || !estadoWA.conectado) throw new Error('WhatsApp no está conectado')
  const messageId = generateMessageIDV2(sock.user?.id)
  recordarId(messageId)
  await sock.sendMessage(jid, contenido, { messageId })
}

const manejador = crearManejador({
  enviarTexto: (jid, texto) => enviar(jid, { text: texto }),
  escribiendo: async (jid, activo) => {
    try { await sock?.sendPresenceUpdate(activo ? 'composing' : 'paused', jid) } catch {}
  },
  // Aviso a Tomás (NUMERO_AVISOS o "mensaje a ti mismo") y, si hay, a quien atiende la zona
  avisar: async (texto, extras = []) => {
    const dueno = config.numeroAvisos
      ? `${config.numeroAvisos}@s.whatsapp.net`
      : jidNormalizedUser(sock?.user?.id)
    const destinos = [...new Set([dueno, ...extras.map(n => `${n}@s.whatsapp.net`)].filter(Boolean))]
    for (const destino of destinos) {
      console.log('AVISO →', destino, texto.replace(/\n/g, ' | '))
      try { await enviar(destino, { text: texto }) } catch (e) { console.error('No pude enviar el aviso:', e.message) }
    }
  },
  marcarLeido: async (llaves) => { await sock?.readMessages(llaves) },
  esIdDelBot: (id) => idsDelBot.has(id),
  esChatPropio: (jid) => {
    const yo = sock?.user
    if (!yo) return false
    return [yo.id, yo.lid].filter(Boolean).map(jidNormalizedUser).includes(jidNormalizedUser(jid))
  }
})

export async function iniciarWhatsApp () {
  const { state, saveCreds } = await useMultiFileAuthState(carpetaSesion)
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}

  sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false, // así tu teléfono sigue recibiendo notificaciones
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  })
  const actual = sock
  let codigoPedido = false

  actual.ev.on('creds.update', saveCreds)

  actual.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (actual !== sock) return
    if (qr) {
      estadoWA.qrImagen = await QRCode.toDataURL(qr, { margin: 1, width: 300 }).catch(() => '')
      if (!codigoPedido && config.numeroWhatsApp && !actual.authState.creds.registered) {
        codigoPedido = true
        try {
          const codigo = await actual.requestPairingCode(config.numeroWhatsApp)
          estadoWA.codigoVinculacion = codigo?.match(/.{1,4}/g)?.join('-') || codigo
          console.log('CÓDIGO DE VINCULACIÓN:', estadoWA.codigoVinculacion)
        } catch (e) {
          estadoWA.ultimoError = 'No pude pedir el código: ' + e.message
        }
      }
    }
    if (connection === 'open') {
      reintentos = 0
      estadoWA.conectado = true
      estadoWA.codigoVinculacion = ''
      estadoWA.qrImagen = ''
      estadoWA.ultimoError = ''
      estadoWA.desde = Date.now()
      estadoWA.numero = (actual.user?.id || '').split(':')[0].split('@')[0]
      console.log('✅ WhatsApp conectado como', estadoWA.numero)
    }
    if (connection === 'close') {
      estadoWA.conectado = false
      const codigo = lastDisconnect?.error?.output?.statusCode
      estadoWA.ultimoError = `Conexión cerrada (${codigo || lastDisconnect?.error?.message || 'sin código'})`
      console.log(estadoWA.ultimoError)
      if (codigo === DisconnectReason.loggedOut) {
        console.log('Sesión cerrada desde el teléfono. Borro la sesión para volver a vincular.')
        fs.rmSync(carpetaSesion, { recursive: true, force: true })
      }
      reintentos++
      const espera = Math.min(3000 * reintentos, 60000)
      setTimeout(() => iniciarWhatsApp().catch(e => console.error('Error al reconectar', e)), espera)
    }
  })

  actual.ev.on('messaging-history.set', ({ chats }) => manejador.historialInicial(chats))

  actual.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try { await manejador.procesar(msg, type) } catch (e) { console.error('Error procesando mensaje', e) }
    }
  })
}

/**
 * Mensaje que Tomás escribe desde la app: se envía por WhatsApp, queda en el historial
 * como "tomas" y el bot se pausa en ese chat (igual que si escribiera desde el teléfono).
 */
export async function enviarComoTomas (jid, texto) {
  const limpio = String(texto || '').trim().slice(0, 4000)
  if (!limpio) throw new Error('Mensaje vacío')
  const chat = obtenerChat(jid)
  if (!chat) throw new Error('Chat no encontrado')
  await enviar(jid, { text: limpio })
  if (chat.estado === 'prospecto') {
    const horas = ajustes.pausaAlIntervenirHoras ?? 24
    crearOActualizarChat(jid, { estado: 'pausado', pausadoHasta: Date.now() + horas * 3600_000 })
  }
  agregarAlHistorial(jid, 'tomas', limpio)
}

/** Desvincula este servidor de WhatsApp (para vincular otro número) */
export async function desvincular () {
  try { await sock?.logout() } catch {}
  fs.rmSync(carpetaSesion, { recursive: true, force: true })
}
