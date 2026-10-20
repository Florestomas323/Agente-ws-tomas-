// Carga la configuración: variables secretas (Railway) + ajustes.json + negocio.md
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const env = process.env

const soloDigitos = (s) => (s || '').replace(/\D/g, '')

export const config = {
  // Secretos (se ponen en Railway → Variables)
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  modelo: env.MODELO_IA || 'claude-sonnet-5-5',
  numeroWhatsApp: soloDigitos(env.NUMERO_WHATSAPP), // el número que vas a vincular, con código de país (1...)
  numeroAvisos: soloDigitos(env.NUMERO_AVISOS),     // a dónde te llegan los avisos; vacío = "mensaje a ti mismo"
  panelClave: env.PANEL_CLAVE || '',
  calendarioUrl: env.CALENDARIO_URL || '',          // URL del Apps Script (opcional)
  calendarioClave: env.CALENDARIO_CLAVE || '',
  zoomEnlace: (env.ZOOM_LINK || '').trim(),          // tu sala personal de Zoom (opcional)
  carpetaDatos: env.DATA_DIR || path.join(aqui, 'datos'),
  puerto: Number(env.PORT || 3000)
}

export function cargarAjustes () {
  const crudo = JSON.parse(fs.readFileSync(path.join(aqui, 'ajustes.json'), 'utf8'))
  // quita las claves de ayuda que empiezan con "_"
  for (const k of Object.keys(crudo)) if (k.startsWith('_')) delete crudo[k]
  return crudo
}

export function cargarInstrucciones () {
  const negocio = fs.readFileSync(path.join(aqui, 'negocio.md'), 'utf8')
  const archivoEstilo = path.join(aqui, 'estilo.md')
  const estilo = fs.existsSync(archivoEstilo) ? fs.readFileSync(archivoEstilo, 'utf8') : ''
  return negocio + (estilo ? '\n\n' + estilo : '')
}

export const ajustes = cargarAjustes()
fs.mkdirSync(config.carpetaDatos, { recursive: true })
