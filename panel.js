// Panel web para el celular: vincular WhatsApp, ver citas, pausar/reactivar chats.
import http from 'node:http'
import crypto from 'node:crypto'
import { DateTime } from 'luxon'
import { config, ajustes } from './config.js'
import { estadoWA, desvincular } from './whatsapp.js'
import {
  listarChats, listarCitas, obtenerChat, crearOActualizarChat, botActivo, cambiarBotActivo
} from './almacen.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const zona = () => ajustes.zonaHoraria || 'America/Chicago'
const fecha = (ms) => ms ? DateTime.fromMillis(ms).setZone(zona()).setLocale('es').toFormat("d LLL, h:mm a") : ''
const fechaISO = (iso) => DateTime.fromISO(iso).setZone(zona()).setLocale('es').toFormat("ccc d 'de' LLL, h:mm a")
const ficha = () => crypto.createHash('sha256').update('panel:' + config.panelClave).digest('hex').slice(0, 32)

function autorizado (req) {
  if (!config.panelClave) return false
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')))
  return cookies.panel === ficha()
}

function leerCuerpo (req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy() })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))))
  })
}

const ETIQUETAS = {
  prospecto: ['Bot contestando', 'ok'],
  pausado: ['En pausa (tú)', 'warn'],
  humano: ['Te toca a ti', 'alert'],
  conocido: ['Ignorado', 'mute']
}

function pagina (titulo, cuerpo, refrescar = 0) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refrescar ? `<meta http-equiv="refresh" content="${refrescar}">` : ''}
<title>${esc(titulo)}</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e6e3dc;--brand:#0f5c4d;--ok:#1f7a4d;--warn:#a86a00;--alert:#b3261e;--mute:#8a8984;--bubble:#e8f3ee;--bubble2:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe7;--muted:#a3a29c;--line:#2e2d2a;--brand:#4fb39a;--ok:#5cc28c;--warn:#e0a63a;--alert:#ff8a80;--mute:#8a8984;--bubble:#1f3a31;--bubble2:#262624}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:22px;margin:8px 0 16px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.fila{display:flex;justify-content:space-between;align-items:center;gap:10px}
.muted{color:var(--muted);font-size:14px}.chip{font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px;border:1px solid currentColor;white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}.alert{color:var(--alert)}.mute{color:var(--mute)}
button,.btn{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:9px 14px;font-size:15px;font-weight:600;text-decoration:none;display:inline-block}
.primario{background:var(--brand);border-color:var(--brand);color:#fff}
.codigo{font:700 34px/1.1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-align:center;padding:18px 0;color:var(--brand)}
ol{padding-left:20px;margin:8px 0}li{margin:4px 0}
input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:16px;margin:8px 0}
.burbuja{max-width:85%;padding:9px 12px;border-radius:12px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word}
.cliente{background:var(--bubble2);border:1px solid var(--line)}.bot,.tomas{background:var(--bubble);margin-left:auto}
.acciones{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}form{margin:0}
a{color:var(--brand)}details summary{cursor:pointer;color:var(--brand);font-weight:600}
</style></head><body><main>${cuerpo}</main></body></html>`
}

function boton (accion, texto, id = '', clase = '') {
  return `<form method="post" action="/accion"><input type="hidden" name="accion" value="${accion}"><input type="hidden" name="id" value="${esc(id)}"><button class="${clase}">${esc(texto)}</button></form>`
}

function vistaInicio () {
  let wa
  if (estadoWA.conectado) {
    wa = `<div class="card fila"><div><strong class="ok">● Conectado</strong><div class="muted">+${esc(estadoWA.numero)} · desde ${fecha(estadoWA.desde)}</div></div></div>`
  } else if (estadoWA.codigoVinculacion || estadoWA.qrImagen) {
    wa = `<div class="card"><strong class="warn">● Falta vincular WhatsApp</strong>
${estadoWA.codigoVinculacion ? `<div class="codigo">${esc(estadoWA.codigoVinculacion)}</div>
<ol class="muted"><li>Abre WhatsApp (o WhatsApp Business) en tu iPhone.</li><li>Ajustes → Dispositivos vinculados → Vincular un dispositivo.</li><li>Toca <b>“Vincular con el número de teléfono”</b> y escribe este código.</li></ol>
<p class="muted">El código cambia cada pocos minutos; esta página se actualiza sola.</p>` : '<p class="muted">Pon NUMERO_WHATSAPP en las variables de Railway para recibir un código de 8 letras.</p>'}
${estadoWA.qrImagen ? `<details><summary>O escanear QR desde otro teléfono</summary><p><img src="${estadoWA.qrImagen}" width="260" height="260" alt="QR"></p></details>` : ''}
</div>`
  } else {
    wa = `<div class="card"><strong class="warn">● Conectando…</strong><div class="muted">${esc(estadoWA.ultimoError)}</div></div>`
  }

  const activo = botActivo()
  const interruptor = `<div class="card fila"><div><strong>${activo ? 'Bot encendido' : 'Bot apagado'}</strong><div class="muted">${activo ? 'Contesta a los prospectos nuevos' : 'No contesta a nadie'}</div></div>
${boton(activo ? 'bot_off' : 'bot_on', activo ? 'Apagar' : 'Encender', '', activo ? '' : 'primario')}</div>`

  const proximas = listarCitas().filter(c => c.estado === 'agendada' && c.fin > DateTime.now().toISO())
  const citas = proximas.length
    ? proximas.map(c => `<div class="card"><div class="fila"><strong>${esc(c.nombre)}</strong><span class="muted">${esc(fechaISO(c.inicio))}</span></div>
<div class="muted">📍 ${esc(c.direccion)}</div>${c.notas ? `<div class="muted">📝 ${esc(c.notas)}</div>` : ''}
<div class="acciones">${c.telefono ? `<a class="btn" href="https://wa.me/${esc(c.telefono)}">WhatsApp</a>` : ''}<a class="btn" href="https://maps.apple.com/?q=${encodeURIComponent(c.direccion)}">Mapa</a></div></div>`).join('')
    : '<div class="card muted">Todavía no hay citas agendadas por el bot.</div>'

  const chats = listarChats().filter(c => c.estado !== 'conocido').slice(0, 60)
  const lista = chats.length
    ? chats.map(c => {
      const [et, cl] = ETIQUETAS[c.estado] || [c.estado, 'mute']
      const ult = c.historial[c.historial.length - 1]
      return `<a href="/chat?id=${encodeURIComponent(c.id)}" style="text-decoration:none;color:inherit"><div class="card">
<div class="fila"><strong>${esc(c.nombre || '+' + (c.telefono || c.id.split('@')[0]))}</strong><span class="chip ${cl}">${et}</span></div>
<div class="muted">${esc((ult?.texto || '').slice(0, 90))}</div><div class="muted">${fecha(c.actualizado)}${c.origen ? ' · ' + esc(c.origen) : ''}</div></div></a>`
    }).join('')
    : '<div class="card muted">Cuando alguien escriba desde una campaña, aparecerá aquí.</div>'

  return pagina('Agente de citas', `<h1>Agente de citas</h1>${wa}${interruptor}<h2>Próximas citas</h2>${citas}<h2>Conversaciones</h2>${lista}
<h2>Sesión</h2><div class="card fila"><span class="muted">Desvincular este número del bot</span>${boton('desvincular', 'Desvincular')}</div>`,
  estadoWA.conectado ? 60 : 15)
}

function vistaChat (id) {
  const c = obtenerChat(id)
  if (!c) return pagina('No encontrado', '<p>Chat no encontrado. <a href="/">Volver</a></p>')
  const [et, cl] = ETIQUETAS[c.estado] || [c.estado, 'mute']
  const burbujas = c.historial.map(h => `<div class="burbuja ${h.rol}"><div class="muted" style="font-size:12px">${h.rol === 'cliente' ? 'Cliente' : h.rol === 'bot' ? 'Bot' : 'Tú'} · ${fecha(h.t)}</div>${esc(h.texto)}</div>`).join('')
  const acciones = [
    c.estado !== 'prospecto' ? boton('activar', 'Que el bot conteste', id, 'primario') : '',
    c.estado === 'prospecto' ? boton('pausar', 'Pausar bot aquí', id) : '',
    c.estado !== 'conocido' ? boton('ignorar', 'Ignorar chat', id) : ''
  ].join('')
  return pagina(c.nombre || 'Chat', `<p><a href="/">← Volver</a></p>
<div class="card"><div class="fila"><strong>${esc(c.nombre || '')}</strong><span class="chip ${cl}">${et}</span></div>
<div class="muted">${c.telefono ? `<a href="https://wa.me/${esc(c.telefono)}">+${esc(c.telefono)}</a>` : esc(c.id)}${c.anuncio ? ' · Anuncio: ' + esc(c.anuncio) : ''}</div>
<div class="acciones">${acciones}</div></div>${burbujas || '<p class="muted">Sin mensajes guardados.</p>'}`)
}

function vistaEntrar (error = '') {
  if (!config.panelClave) return pagina('Configurar', '<h1>Falta PANEL_CLAVE</h1><p>Agrega la variable PANEL_CLAVE en Railway para proteger este panel.</p>')
  return pagina('Entrar', `<h1>Agente de citas</h1><form method="post" action="/entrar" class="card">
<label>Clave del panel<input type="password" name="clave" autocomplete="current-password" autofocus></label>
${error ? `<p class="alert">${esc(error)}</p>` : ''}<button class="primario">Entrar</button></form>`)
}

export function iniciarPanel () {
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const enviar = (html, codigo = 200, extra = {}) => { res.writeHead(codigo, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(html) }
    const ir = (a, extra = {}) => { res.writeHead(303, { Location: a, ...extra }); res.end() }

    try {
      if (url.pathname === '/salud') { res.writeHead(200); return res.end('ok') }

      if (url.pathname === '/entrar' && req.method === 'POST') {
        const { clave } = await leerCuerpo(req)
        if (config.panelClave && clave === config.panelClave) {
          return ir('/', { 'Set-Cookie': `panel=${ficha()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` })
        }
        return enviar(vistaEntrar('Clave incorrecta'), 401)
      }

      if (!autorizado(req)) return enviar(vistaEntrar())

      if (url.pathname === '/accion' && req.method === 'POST') {
        const { accion, id } = await leerCuerpo(req)
        if (accion === 'bot_on') cambiarBotActivo(true)
        if (accion === 'bot_off') cambiarBotActivo(false)
        if (accion === 'activar' && obtenerChat(id)) crearOActualizarChat(id, { estado: 'prospecto', pausadoHasta: null })
        if (accion === 'pausar' && obtenerChat(id)) crearOActualizarChat(id, { estado: 'pausado', pausadoHasta: null })
        if (accion === 'ignorar' && obtenerChat(id)) crearOActualizarChat(id, { estado: 'conocido' })
        if (accion === 'desvincular') await desvincular()
        return ir(id && accion !== 'ignorar' ? `/chat?id=${encodeURIComponent(id)}` : '/')
      }

      if (url.pathname === '/chat') return enviar(vistaChat(url.searchParams.get('id')))
      return enviar(vistaInicio())
    } catch (e) {
      console.error('Error en el panel', e)
      enviar('Error: ' + esc(e.message), 500)
    }
  })
  servidor.listen(config.puerto, () => console.log(`Panel en el puerto ${config.puerto}`))
  return servidor
}
