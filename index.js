require('dotenv').config({ path: 'example.env' });
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 4000;

app.use(express.json());

// Verificación de variables
if (!process.env.ZOOM_WEBHOOK_SECRET_TOKEN ||
    !process.env.ZOOM_ACCOUNT_ID ||
    !process.env.ZOOM_CLIENT_ID ||
    !process.env.ZOOM_CLIENT_SECRET ||
    !process.env.N8N_WEBHOOK_URL ||
    !process.env.N8N_WEBHOOK_URL_START) {
  console.error('❌ Variables de entorno faltantes');
  process.exit(1);
}

// Obtener token OAuth
async function getZoomAccessToken() {
  const credentials = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const url = 'https://zoom.us/oauth/token';

  const response = await axios.post(url, null, {
    params: {
      grant_type: 'account_credentials',
      account_id: process.env.ZOOM_ACCOUNT_ID
    },
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 10000
  });

  return response.data.access_token;
}

// Obtener participantes
async function getAllParticipants(webinarId) {
  const accessToken = await getZoomAccessToken();
  const baseUrl = `https://api.zoom.us/v2/report/webinars/${webinarId}/participants`;

  let all = [], token = null;
  do {
    const response = await axios.get(baseUrl, {
      params: {
        page_size: 300,
        ...(token && { next_page_token: token })
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      timeout: 10000
    });
    all = [...all, ...response.data.participants];
    token = response.data.next_page_token || null;
  } while (token);

  return all;
}

// Obtener registrados
async function getRegistrants(webinarId) {
  const accessToken = await getZoomAccessToken();
  const baseUrl = `https://api.zoom.us/v2/webinars/${webinarId}/registrants`;

  let all = [], token = null;
  do {
    const response = await axios.get(baseUrl, {
      params: {
        page_size: 300,
        status: 'approved',
        ...(token && { next_page_token: token })
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      timeout: 10000
    });
    all = [...all, ...response.data.registrants];
    token = response.data.next_page_token || null;
  } while (token);

  return all;
}

// Webhook
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body.event;
    console.log(`📩 Evento recibido: ${event}`);

    // Validación firma
    const msg = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const expected = `v0=${crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(msg).digest('hex')}`;
    if (req.headers['x-zm-signature'] !== expected) {
      console.error('🚫 Firma no válida');
      return res.status(401).json({ error: 'Firma inválida' });
    }

    // Validación inicial Zoom
    if (event === 'endpoint.url_validation') {
      const token = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(req.body.payload.plainToken)
        .digest('hex');

      return res.json({
        plainToken: req.body.payload.plainToken,
        encryptedToken: token
      });
    }

    // Evento: seminario iniciado
    if (event === 'webinar.started') {
      res.status(200).json({ success: true });

      const data = req.body.payload?.object;
      if (!data || !data.id) {
        console.error('❌ Payload inválido (webinar.started)');
        return;
      }

      const payloadToN8n = {
        event: 'webinar.started',
        webinar_id: data.id,
        webinar_details: {
          topic: data.topic,
          start_time: data.start_time,
          timezone: data.timezone || 'America/Santiago'
        },
        metadata: {
          generated_at: new Date().toISOString(),
          source: 'Zoom Webhook Processor'
        }
      };

      try {
        console.log('🚀 Enviando inicio de seminario a n8n...');
        await axios.post(process.env.N8N_WEBHOOK_URL_START, payloadToN8n, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        });
        console.log('✅ Notificación de inicio enviada');
      } catch (err) {
        console.error('❌ Error enviando a n8n (inicio):', err.message);
      }

      return;
    }

    // Evento: seminario finalizado
    if (event === 'webinar.ended') {
      res.status(200).json({ success: true });

      const data = req.body.payload?.object;
      if (!data || !data.id) {
        console.error('❌ Payload inválido (webinar.ended)');
        return;
      }

      try {
        const [participants, registrants] = await Promise.all([
          getAllParticipants(data.id),
          getRegistrants(data.id)
        ]);

        const attended = new Set(participants.map(p => p.email?.toLowerCase()));
        const noShows = registrants.filter(r => !attended.has(r.email?.toLowerCase()));

        const payloadToN8n = {
          event: 'webinar.ended',
          webinar_id: data.id,
          webinar_details: {
            topic: data.topic,
            start_time: data.start_time,
            end_time: data.end_time,
            duration: data.duration
          },
          attendance_stats: {
            total_registrants: registrants.length,
            total_participants: participants.length,
            no_shows_count: noShows.length,
            attendance_rate: registrants.length > 0
              ? Math.round((participants.length / registrants.length) * 100)
              : 0
          },
          participants,
          registrants,
          no_shows: noShows,
          metadata: {
            generated_at: new Date().toISOString(),
            source: 'Zoom Webhook Processor'
          }
        };

        console.log('📤 Enviando finalización a n8n...');
        await axios.post(process.env.N8N_WEBHOOK_URL, payloadToN8n, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        console.log('✅ Datos enviados correctamente');
      } catch (error) {
        console.error('❌ Error procesando webinar.ended:', error.message);
      }

      return;
    }

    // Otros eventos (ignorar pero responder)
    res.status(200).end();

  } catch (error) {
    console.error('🔥 Error crítico:', error.message);
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({
      error: 'Error interno',
      details: error.message,
      ...(error.response && { responseData: error.response.data })
    });
  }
});

// Servidor
app.listen(port, () => {
  console.log(`
🚀 Servidor escuchando en puerto ${port}
🔗 Endpoint: /webhook
🧠 Maneja eventos: webinar.started, webinar.ended
`);
});

