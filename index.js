require('dotenv').config({ path: 'example.env' });
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Verificación de variables actualizada para OAuth
if (!process.env.ZOOM_WEBHOOK_SECRET_TOKEN || 
    !process.env.N8N_WEBHOOK_URL || 
    !process.env.ZOOM_ACCOUNT_ID || 
    !process.env.ZOOM_CLIENT_ID || 
    !process.env.ZOOM_CLIENT_SECRET) {
  console.error('❌ Error: Variables de entorno faltantes en example.env');
  process.exit(1);
}

// Función para obtener token de acceso OAuth
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

// Nueva función para obtener todos los participantes con OAuth
async function getAllParticipants(webinarId) {
  let allParticipants = [];
  let nextPageToken = null;
  let pageCount = 0;
  const baseUrl = `https://api.zoom.us/v2/report/webinars/${webinarId}/participants`;

  // Obtener token de acceso
  const accessToken = await getZoomAccessToken();
  console.log('🔑 Token OAuth obtenido');

  do {
    pageCount++;
    console.log(`📖 Obteniendo página ${pageCount} de participantes...`);
    
    try {
      const params = {
        page_size: 300,  // Máximo permitido por Zoom
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

    // Procesar solo webinar.ended
    if (req.body.event === 'webinar.ended') {
      // Responder inmediatamente a Zoom
      res.status(200).json({ success: true });
      
      console.log('🔍 Obteniendo todos los participantes...');
      const webinarId = req.body.payload.id;
      
      try {
        // Obtener todos los participantes paginados
        const participants = await getAllParticipants(webinarId);
        console.log(`👥 Total de participantes obtenidos: ${participants.length}`);

        // Enviar solo los datos esenciales a n8n
        const payloadToN8N = {
          event: 'webinar.ended',
          payload: {
            id: webinarId,
            uuid: req.body.payload.uuid,
            topic: req.body.payload.topic,
            start_time: req.body.payload.start_time,
            end_time: req.body.payload.end_time,
            duration: req.body.payload.duration,
            participants: participants
          }
        };

        console.log(`🔄 Enviando ${participants.length} participantes a n8n...`);
        await axios.post(process.env.N8N_WEBHOOK_URL, payloadToN8N, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000 // 30 segundos para enviar
        });
        
        console.log('✅ Datos enviados exitosamente a n8n');
      } catch (error) {
        console.error('⚠️ Error procesando participantes:', error.message);
      }
      
      return;
    }

    res.status(200).end(); // Respuesta para otros eventos

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
  📌 Variables cargadas desde example.env
  🔗 Endpoint n8n: ${process.env.N8N_WEBHOOK_URL}
  🔑 Zoom OAuth usando Account ID: ${process.env.ZOOM_ACCOUNT_ID}
  `);
});
