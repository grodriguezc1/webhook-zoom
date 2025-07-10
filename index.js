require('dotenv').config({ path: 'example.env' });
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Verificación de variables de entorno
if (!process.env.ZOOM_WEBHOOK_SECRET_TOKEN || 
    !process.env.N8N_WEBHOOK_URL || 
    !process.env.ZOOM_ACCOUNT_ID || 
    !process.env.ZOOM_CLIENT_ID || 
    !process.env.ZOOM_CLIENT_SECRET) {
  console.error('❌ Error: Variables de entorno faltantes en example.env');
  process.exit(1);
}

// Función para obtener token OAuth
async function getZoomAccessToken() {
  try {
    const credentials = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post('https://zoom.us/oauth/token', null, {
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
  } catch (error) {
    console.error('⚠️ Error obteniendo token OAuth:', error.response?.data || error.message);
    throw error;
  }
}

// Función para obtener participantes
async function getAllParticipants(webinarId) {
  let allParticipants = [];
  let nextPageToken = null;
  let pageCount = 0;
  const baseUrl = `https://api.zoom.us/v2/report/webinars/${webinarId}/participants`;

  const accessToken = await getZoomAccessToken();

  do {
    pageCount++;
    console.log(`📖 Obteniendo página ${pageCount} de participantes...`);
    
    try {
      const params = {
        page_size: 300,
        ...(nextPageToken && { next_page_token: nextPageToken })
      };

      const response = await axios.get(baseUrl, {
        params,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      allParticipants = [...allParticipants, ...response.data.participants];
      nextPageToken = response.data.next_page_token || null;
      
      console.log(`✅ Página ${pageCount} obtenida: ${response.data.participants.length} participantes`);
    } catch (error) {
      console.error('⚠️ Error obteniendo participantes:', error.response?.data || error.message);
      throw error;
    }
  } while (nextPageToken);

  return allParticipants;
}

// Función para obtener registrados
async function getRegistrants(webinarId) {
  let allRegistrants = [];
  let nextPageToken = null;
  let pageCount = 0;
  const baseUrl = `https://api.zoom.us/v2/webinars/${webinarId}/registrants`;

  const accessToken = await getZoomAccessToken();

  do {
    pageCount++;
    console.log(`📖 Obteniendo página ${pageCount} de registrados...`);
    
    try {
      const params = {
        page_size: 300,
        status: 'approved', // Solo registros aprobados
        ...(nextPageToken && { next_page_token: nextPageToken })
      };

      const response = await axios.get(baseUrl, {
        params,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      allRegistrants = [...allRegistrants, ...response.data.registrants];
      nextPageToken = response.data.next_page_token || null;
      
      console.log(`✅ Página ${pageCount} obtenida: ${response.data.registrants.length} registrados`);
    } catch (error) {
      console.error('⚠️ Error obteniendo registrados:', error.response?.data || error.message);
      throw error;
    }
  } while (nextPageToken);

  return allRegistrants;
}

// Middleware
app.use(express.json());

// Routes
app.post('/webhook', async (req, res) => {
  try {
    console.log('📩 Evento recibido:', req.body.event);

    // Validación de firma Zoom
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const signature = `v0=${crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(message)
      .digest('hex')}`;

    if (signature !== req.headers['x-zm-signature']) {
      console.error('🚫 Firma inválida');
      return res.status(401).json({ error: 'Firma no válida' });
    }

    // Validación inicial de Zoom
    if (req.body.event === 'endpoint.url_validation') {
      const responseToken = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(req.body.payload.plainToken)
        .digest('hex');
      
      return res.json({
        plainToken: req.body.payload.plainToken,
        encryptedToken: responseToken
      });
    }

    // Procesar webinar.ended
    if (req.body.event === 'webinar.ended') {
      res.status(200).json({ success: true });
      
      if (!req.body.payload.object || !req.body.payload.object.id) {
        console.error('❌ Estructura de payload inválida');
        return;
      }

      const webinarInfo = req.body.payload.object;
      const webinarId = webinarInfo.id;
      
      try {
        // Obtener datos en paralelo
        const [participants, registrants] = await Promise.all([
          getAllParticipants(webinarId),
          getRegistrants(webinarId)
        ]);

        // Calcular no-shows
        const attendedEmails = new Set(participants.map(p => p.email?.toLowerCase()));
        const noShows = registrants.filter(
          r => !attendedEmails.has(r.email?.toLowerCase())
        );

        // Preparar payload para n8n
        const payloadToN8N = {
          event: 'webinar.ended',
          webinar_id: webinarId,
          webinar_details: {
            topic: webinarInfo.topic,
            start_time: webinarInfo.start_time,
            end_time: webinarInfo.end_time,
            duration: webinarInfo.duration
          },
          attendance_stats: {
            total_registrants: registrants.length,
            total_participants: participants.length,
            no_shows_count: noShows.length,
            attendance_rate: registrants.length > 0 
              ? Math.round((participants.length / registrants.length) * 100)
              : 0
          },
          participants: participants,
          registrants: registrants,
          no_shows: noShows,
          metadata: {
            generated_at: new Date().toISOString(),
            source: 'Zoom Webhook Processor'
          }
        };

        console.log(`🔄 Enviando datos a n8n...`);
        await axios.post(process.env.N8N_WEBHOOK_URL, payloadToN8N, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        
        console.log('✅ Datos enviados exitosamente');
      } catch (error) {
        console.error('⚠️ Error procesando webinar:', error.message);
      }
      return;
    }

    res.status(200).end();
  } catch (error) {
    console.error('🔥 Error crítico:', error.message);
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({
      error: 'Error en el servidor',
      details: error.message,
      ...(error.response && { responseData: error.response.data })
    });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`
  🚀 Servidor activo en puerto ${port}
  🔗 Endpoint: /webhook
  🔑 Autenticación OAuth habilitada
  📊 Reportes completos de participantes y registrados
  `);
});
