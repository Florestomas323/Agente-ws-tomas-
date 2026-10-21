// Transcribe notas de voz con OpenAI (variable OPENAI_API_KEY en Railway).
// Modelo por defecto: gpt-4o-mini-transcribe (barato y bueno en español). Se puede cambiar con MODELO_TRANSCRIPCION.

const EXTENSION = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/amr': 'amr' }

/**
 * @param {Buffer} buffer  audio descargado de WhatsApp (normalmente ogg/opus)
 * @param {string} [mimetype]
 * @returns {Promise<string>} texto transcrito ('' si no hay clave)
 */
export async function transcribirAudio (buffer, mimetype = 'audio/ogg') {
  const clave = (process.env.OPENAI_API_KEY || '').trim()
  if (!clave || !buffer?.length) return ''
  const tipo = String(mimetype).split(';')[0].trim() || 'audio/ogg'
  const forma = new FormData()
  forma.append('file', new Blob([buffer], { type: tipo }), 'nota.' + (EXTENSION[tipo] || 'ogg'))
  forma.append('model', process.env.MODELO_TRANSCRIPCION || 'gpt-4o-mini-transcribe')
  forma.append('prompt', 'Nota de voz de WhatsApp de un cliente latino en Estados Unidos que habla de agendar una cita, su ciudad, su dirección o su código postal. Puede mezclar español e inglés.')
  const url = (process.env.OPENAI_URL || 'https://api.openai.com').replace(/\/+$/, '') + '/v1/audio/transcriptions'
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + clave },
    body: forma,
    signal: AbortSignal.timeout(60000)
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error('OpenAI: ' + (j.error?.message || 'HTTP ' + r.status))
  return String(j.text || '').trim()
}
