// Punto de entrada: arranca el panel web y la conexión con WhatsApp.
import { config } from './config.js'
import { guardarYa } from './almacen.js'
import { iniciarPanel } from './panel.js'
import { iniciarWhatsApp } from './whatsapp.js'

const faltan = []
if (!config.anthropicKey) faltan.push('ANTHROPIC_API_KEY')
if (!config.panelClave) faltan.push('PANEL_CLAVE')
if (!config.numeroWhatsApp) faltan.push('NUMERO_WHATSAPP')
if (faltan.length) console.warn('⚠️ Faltan variables:', faltan.join(', '))
if (!config.calendarioUrl) console.warn('ℹ️ Sin CALENDARIO_URL: el bot no verá tu Google Calendar, solo las citas que él mismo agende.')

iniciarPanel()
iniciarWhatsApp().catch(e => {
  console.error('No pude iniciar WhatsApp', e)
  process.exit(1)
})

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => { try { guardarYa() } catch {} process.exit(0) })
}
process.on('unhandledRejection', e => console.error('Promesa sin manejar:', e))
