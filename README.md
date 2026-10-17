# Agente de citas por WhatsApp — Impact Enterprises

Contesta solo a las personas que te escriben desde tus campañas de Facebook/Instagram, las califica, les ofrece horarios libres de tu Google Calendar y agenda la demostración. Cuando agenda o cuando necesita que tú intervengas, te avisa por WhatsApp.

Todo se instala desde el iPhone: **GitHub** (código) → **Railway** (servidor 24/7, unos $5 al mes) → **Google Apps Script** (conexión con tu calendario, gratis).

---

## Cómo se comporta

| Situación | Qué hace el bot |
|---|---|
| Alguien escribe desde un anuncio “clic a WhatsApp” | Contesta, pide nombre y ciudad, ofrece la demo y agenda |
| El primer mensaje trae una frase clave (ej. “quiero más información”) | Lo trata como prospecto de campaña |
| Amigos, familia, clientes que ya tenías, grupos | **No contesta** |
| Tú escribes a mano en un chat que lleva el bot | El bot se calla en ese chat por 24 h |
| Cliente actual, queja, duda que no sabe, zona que no cubres | Te avisa (“Te toca a ti”) y deja de contestar en ese chat |
| Cliente manda varios mensajes seguidos | Espera unos segundos y contesta todo junto |
| Cada respuesta | Pone el visto, se toma un momento, aparece “escribiendo…” al ritmo de una persona y nunca tarda exactamente lo mismo |
| Agenda una cita | Crea el evento en tu Google Calendar (azul Pavo real) y te manda el resumen |

Cuando vinculas el número, todos los chats que ya existían quedan marcados como “ignorados”, así el bot nunca les contesta a tus clientes actuales.

---

## Paso 1 — Subir el código a GitHub
1. En github.com (Safari) → **+** → **New repository** → nombre `agente-citas-whatsapp` → **Private** → Create.
2. Descomprime el zip en la app Archivos.
3. En el repo: **Add file → Upload files** → selecciona **todos** los archivos del zip → Commit.

## Paso 2 — Clave de la IA
En console.anthropic.com → **API Keys** → **Create Key**. Cópiala; la usarás en el paso 3.

## Paso 3 — Servidor en Railway
1. Entra a railway.com con tu cuenta de GitHub y activa el plan Hobby.
2. **New Project → Deploy from GitHub repo** → elige `agente-citas-whatsapp`.
3. **Volumen (importante: ahí se guarda la sesión de WhatsApp y las citas):** en el proyecto toca **Create → Volume**, conéctalo al servicio y pon como ruta de montaje (*mount path*) `/data`.
4. En el servicio → **Variables** → agrega:

| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | la clave del paso 2 |
| `NUMERO_WHATSAPP` | el número que vas a vincular, con 1 adelante y sin signos. Ej: `16823811576` |
| `PANEL_CLAVE` | una clave para entrar al panel |
| `DATA_DIR` | `/data` |
| `NUMERO_AVISOS` | *(opcional)* número donde quieres los avisos. Vacío = te llegan al chat “Tú” (mensaje a ti mismo) |
| `CALENDARIO_URL` | *(paso 5)* URL del Apps Script |
| `CALENDARIO_CLAVE` | *(paso 5)* la clave que pongas en el Apps Script |
| `MODELO_IA` | *(opcional)* por defecto `claude-sonnet-5-5` |

5. **Settings → Networking → Generate Domain**. Esa dirección es tu **panel**. Guárdala en tu pantalla de inicio.

## Paso 4 — Vincular WhatsApp
1. Abre el panel, entra con tu `PANEL_CLAVE`.
2. Vas a ver un **código de 8 letras**.
3. En WhatsApp Business: **Ajustes → Dispositivos vinculados → Vincular un dispositivo → “Vincular con el número de teléfono”** y escribe el código.
4. El panel cambia a **● Conectado**. Tu teléfono sigue funcionando normal.

> Recomendación: prueba primero con un número secundario. Escríbele desde otro teléfono la frase de tu anuncio y revisa cómo contesta.

## Paso 5 — Conectar tu Google Calendar
Sin esto el bot funciona, pero no ve tus otras citas (cobranza, servicio…) y podría ofrecer un horario que ya tienes ocupado.

1. En Safari abre script.google.com (si se ve mal, usa **aA → Solicitar sitio de escritorio**).
2. **Nuevo proyecto** → borra lo que hay → pega el contenido de `Code.gs`.
3. Cambia `CAMBIA-ESTA-CLAVE` por una clave tuya → guardar.
4. **Implementar → Nueva implementación → ⚙️ Aplicación web**
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
5. Autoriza (si sale “Google no verificó esta app”: **Configuración avanzada → Ir a…**). Es tu propio script.
6. Copia la URL que termina en `/exec` → en Railway: `CALENDARIO_URL` = esa URL y `CALENDARIO_CLAVE` = tu clave.
7. Prueba: abre la URL en Safari; debe decir “Puente de calendario funcionando”.

Todos los eventos de tu calendario cuentan como ocupado (menos los de todo el día), con 30 min de margen para manejar.

## Paso 6 — Ajustar a tu gusto (desde GitHub)
Cada vez que guardas un cambio en GitHub, Railway se actualiza solo en un minuto **sin perder la vinculación**.

- **`negocio.md`**: cómo habla el bot, qué ofrece, zonas, reglas. Revisa las líneas marcadas **[EDITAR]** (regalo/promoción, zonas, si pides que esté la pareja).
- **`ajustes.json`**:
  - `frasesClave`: pon aquí el **mensaje prellenado de tu anuncio**.
  - `horarios`: horas que puede ofrecer cada día.
  - `duracionCitaMinutos`, `margenTrasladoMinutos`, `anticipacionMinimaHoras`.
  - `calendario.invitados`: correos que quieres invitados en cada cita.
  - `modoRespuesta`: `campanas` (recomendado), `nuevos` o `todos`.

---

## El panel
- **Encender / apagar** el bot completo.
- **Próximas citas** con botones de WhatsApp y Mapa.
- **Conversaciones**: verde = bot contestando · amarillo = en pausa porque tú escribiste · rojo = te toca a ti.
- Dentro de cada chat: ver la conversación completa, **“Que el bot conteste”**, **pausar** o **ignorar**.

## Cuidados con WhatsApp
Baileys no es la API oficial; WhatsApp puede bloquear números que usan automatización. Este bot está hecho para bajar ese riesgo: **solo contesta a quien te escribe primero**, simula que está escribiendo, espera entre mensajes, no manda mensajes masivos y tiene un límite diario por chat. Aun así, no lo uses para enviar promociones en masa.

## Costos aproximados
- Railway Hobby: unos $5 al mes.
- IA: unos centavos por conversación con pocos prospectos al día.
- Apps Script: gratis.

## Archivos
| Archivo | Para qué |
|---|---|
| `negocio.md` | Instrucciones del asistente (lo que más vas a editar) |
| `estilo.md` | Habilidad de trato humano: cómo conversa (empatía, tono, ritmo, honestidad) |
| `ajustes.json` | Horarios y reglas |
| `index.js` | Arranque |
| `whatsapp.js` | Conexión con WhatsApp (Baileys) |
| `manejador.js` | A quién contestar, pausas, avisos |
| `agente.js` | Conversación con la IA y sus herramientas |
| `calendario.js` | Horarios libres y creación de citas |
| `almacen.js` | Guarda chats y citas en `/data` |
| `panel.js` | Panel web |
| `Code.gs` | Se pega en Google Apps Script, **no** hace falta subirlo a GitHub |
