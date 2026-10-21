// Guarda conversaciones, estado de cada chat y citas en un archivo JSON (en el volumen de Railway)
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { config } from './config.js'

const archivo = path.join(config.carpetaDatos, 'estado.json')
const MAX_HISTORIAL = 40

let datos = { botActivo: true, chats: {}, citas: [], idsProcesados: [], crmCola: [], codigosRegalo: {} }
try {
  if (fs.existsSync(archivo)) datos = { ...datos, ...JSON.parse(fs.readFileSync(archivo, 'utf8')) }
} catch (e) {
  console.error('No pude leer estado.json, empiezo vacío:', e.message)
}

let temporizador = null
function guardar () {
  clearTimeout(temporizador)
  temporizador = setTimeout(guardarYa, 500)
}
export function guardarYa () {
  clearTimeout(temporizador)
  const tmp = archivo + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 1))
  fs.renameSync(tmp, archivo)
}

/**
 * Estados de un chat:
 *  - "prospecto": el bot contesta
 *  - "conocido":  chat que ya existía o que no vino de campaña; el bot no contesta
 *  - "pausado":   Tomás intervino o lo pausó desde el panel (hasta pausadoHasta, o indefinido si es null)
 *  - "humano":    el bot lo pasó a Tomás; no contesta hasta que lo reactives
 */
export function obtenerChat (id) {
  return datos.chats[id]
}

export function crearOActualizarChat (id, cambios) {
  const actual = datos.chats[id] || { id, estado: 'conocido', historial: [], creado: Date.now(), respuestasHoy: { dia: '', n: 0 } }
  datos.chats[id] = { ...actual, ...cambios, actualizado: Date.now() }
  guardar()
  return datos.chats[id]
}

export function agregarAlHistorial (id, rol, texto, t = Date.now()) {
  const chat = datos.chats[id]
  if (!chat) return
  chat.historial.push({ rol, texto, t })
  if (chat.historial.length > MAX_HISTORIAL) chat.historial = chat.historial.slice(-MAX_HISTORIAL)
  chat.actualizado = Date.now()
  guardar()
}

export function contarRespuesta (id, hoy) {
  const chat = datos.chats[id]
  if (!chat) return 0
  if (!chat.respuestasHoy || chat.respuestasHoy.dia !== hoy) chat.respuestasHoy = { dia: hoy, n: 0 }
  chat.respuestasHoy.n++
  guardar()
  return chat.respuestasHoy.n
}

export function listarChats () {
  return Object.values(datos.chats).sort((a, b) => (b.actualizado || 0) - (a.actualizado || 0))
}

export function marcarConocidos (ids) {
  let n = 0
  for (const id of ids) {
    if (!datos.chats[id]) {
      datos.chats[id] = { id, estado: 'conocido', historial: [], creado: Date.now(), actualizado: 0, respuestasHoy: { dia: '', n: 0 } }
      n++
    }
  }
  if (n) guardar()
  return n
}

export function agregarCita (cita) {
  datos.citas.push(cita)
  guardar()
}

export function actualizarCita (id, cambios) {
  const c = datos.citas.find(x => x.id === id)
  if (!c) return null
  Object.assign(c, cambios)
  guardar()
  return c
}

export function listarCitas () {
  return [...datos.citas].sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio))
}

export function botActivo () { return datos.botActivo }
export function cambiarBotActivo (v) { datos.botActivo = !!v; guardar() }

/** Evita procesar dos veces el mismo mensaje (WhatsApp a veces lo reenvía al reconectar) */
export function yaProcesado (idMensaje) {
  if (!idMensaje) return false
  if (datos.idsProcesados.includes(idMensaje)) return true
  datos.idsProcesados.push(idMensaje)
  if (datos.idsProcesados.length > 3000) datos.idsProcesados = datos.idsProcesados.slice(-3000)
  guardar()
  return false
}

// ---------- Cola del CRM (reintentos) ----------
export function colaCrm () { return datos.crmCola }
export function encolarCrm (item) {
  datos.crmCola.push({ id: 'q' + crypto.randomUUID(), intentos: 0, proximo: 0, creado: Date.now(), ...item })
  guardar()
}
/** Pone un envío al frente de la cola (p. ej. volver a mandar el prospecto antes que sus estados) */
export function encolarCrmAlFrente (item) {
  datos.crmCola.unshift({ id: 'q' + crypto.randomUUID(), intentos: 0, proximo: 0, creado: Date.now(), ...item })
  guardar()
}
export function quitarDeColaCrm (id) {
  datos.crmCola = datos.crmCola.filter(x => x.id !== id)
  guardar()
}
export function actualizarEnColaCrm (id, cambios) {
  const x = datos.crmCola.find(i => i.id === id)
  if (x) { Object.assign(x, cambios); guardar() }
}

// ---------- Códigos de regalo (una participación por persona) ----------
/** Registra el código; devuelve el chat que ya lo había usado (si es otro) */
export function registrarCodigoRegalo (codigo, chatId) {
  const c = String(codigo || '').toUpperCase()
  if (!c) return null
  const previo = datos.codigosRegalo[c]
  if (previo && previo !== chatId) return previo
  datos.codigosRegalo[c] = chatId
  guardar()
  return null
}
