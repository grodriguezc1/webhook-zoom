require('dotenv').config({ path: 'example.env' });
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ============================================================
// VERIFICACIÓN DE VARIABLES DE ENTORNO
// ============================================================
const requiredVars = [
  'ZOOM_WEBHOOK_SECRET_TOKEN',
  'ZOOM_ACCOUNT_ID',
  'ZOOM_CLIENT_ID',
  'ZOOM_CLIENT_SECRET',
  'N8N_WEBHOOK_URL',
  'N8N_WEBHOOK_URL_START',
  'N8N_WEBHOOK_URL_RECORDING'
];

// Variables opcionales para WhatsApp
const optionalVars = [
  'N8N_WEBHOOK_WHATSAPP',      // Webhook de n8n para procesar comandos WhatsApp
  'WHATSAPP_API_URL'           // URL de tu whatsapp-web.js para enviar mensajes
];

const missingVars = requiredVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Variables de entorno faltantes:', missingVars.join(', '));
  process.exit(1);
}

// ============================================================
// FUNCIONES ZOOM API
// ============================================================

// Obtener token OAuth
async function getZoomAccessToken() {
  const credentials = Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
  ).toString('base64');

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
}

// Obtener participantes de webinar
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
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });
    all = [...all, ...response.data.participants];
    token = response.data.next_page_token || null;
  } while (token);

  return all;
}

// Obtener registrados de webinar
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
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });
    all = [...all, ...response.data.registrants];
    token = response.data.next_page_token || null;
  } while (token);

  return all;
}

// ============================================================
// WEBHOOK ZOOM (TU CÓDIGO EXISTENTE)
// ============================================================
app.post('/webhook', async (req, res) => {
  try {
    const event = req.body.event;
    console.log(`📩 [ZOOM] Evento recibido: ${event}`);

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


    // Evento: grabacion completada (recording.completed)
    if (event === 'recording.completed') {
      res.status(200).json({ success: true });

      const data = req.body.payload?.object;
      if (!data || !data.id) {
        console.error('Payload invalido (recording.completed)');
        return;
      }

      try {
        const recordingFiles = (data.recording_files || []).map(file => ({
          id: file.id,
          file_type: file.file_type,
          file_extension: file.file_extension,
          file_size: file.file_size,
          play_url: file.play_url,
          download_url: file.download_url,
          status: file.status,
          recording_start: file.recording_start,
          recording_end: file.recording_end,
          recording_type: file.recording_type
        }));

        // Obtener share URL y password limpios desde la API de Zoom
        let shareUrl = data.share_url;
        let sharePassword = data.recording_play_passcode || null;
        try {
          const accessToken = await getZoomAccessToken();
          // El UUID necesita doble encoding si contiene / o //
          const encodedUuid = encodeURIComponent(encodeURIComponent(data.uuid));
          const settingsRes = await axios.get(
            `https://api.zoom.us/v2/meetings/${encodedUuid}/recordings/settings`,
            {
              headers: { 'Authorization': `Bearer ${accessToken}` },
              timeout: 10000
            }
          );
          if (settingsRes.data.share_url) shareUrl = settingsRes.data.share_url;
          if (settingsRes.data.password) sharePassword = settingsRes.data.password;
          console.log('✅ Share URL y password obtenidos desde API');
        } catch (settingsErr) {
          console.error('⚠️ No se pudo obtener settings, usando datos del webhook:', settingsErr.message);
        }

        const payloadToN8n = {
          event: 'recording.completed',
          meeting_id: data.id,
          meeting_uuid: data.uuid,
          host_id: data.host_id,
          host_email: data.host_email,
          topic: data.topic,
          type: data.type,
          start_time: data.start_time,
          duration: data.duration,
          total_size: data.total_size,
          recording_count: data.recording_count,
          share_url: shareUrl,
          share_password: sharePassword,
          recording_files: recordingFiles,
          download_token: req.body.download_token || null,
          metadata: {
            generated_at: new Date().toISOString(),
            source: 'Zoom Webhook Processor'
          }
        };

        console.log(`Recording completed: ${data.topic} (${recordingFiles.length} files)`);
        await axios.post(process.env.N8N_WEBHOOK_URL_RECORDING, payloadToN8n, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        console.log('✅ Recording data sent to n8n');
      } catch (error) {
        console.error('Error processing recording.completed:', error.message);
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

// ============================================================
// WEBHOOK ZOOM AGENTE (General App - OAuth)
// Endpoint separado para la cuenta Agente
// ============================================================
app.post('/webhook-agent', async (req, res) => {
  try {
    const event = req.body.event;
    console.log(`📩 [ZOOM-AGENTE] Evento recibido: ${event}`);

    // Validacion firma con Secret Token del Agente
    const agentSecret = process.env.ZOOM_AGENT_WEBHOOK_SECRET_TOKEN;
    if (!agentSecret) {
      console.error('ZOOM_AGENT_WEBHOOK_SECRET_TOKEN no configurado');
      return res.status(500).json({ error: 'Agent secret not configured' });
    }

    const msg = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const expected = `v0=${crypto.createHmac('sha256', agentSecret).update(msg).digest('hex')}`;
    if (req.headers['x-zm-signature'] !== expected) {
      console.error('[ZOOM-AGENTE] Firma no valida');
      return res.status(401).json({ error: 'Firma invalida' });
    }

    // Validacion inicial Zoom
    if (event === 'endpoint.url_validation') {
      const token = crypto.createHmac('sha256', agentSecret)
        .update(req.body.payload.plainToken)
        .digest('hex');
      return res.json({
        plainToken: req.body.payload.plainToken,
        encryptedToken: token
      });
    }

    // Evento: reunion iniciada
    if (event === 'meeting.started') {
      res.status(200).json({ success: true });

      const data = req.body.payload?.object;
      if (!data || !data.id) {
        console.error('[ZOOM-AGENTE] Payload invalido (meeting.started)');
        return;
      }

      const payloadToN8n = {
        event: 'meeting.started',
        account: 'agente',
        meeting_id: data.id,
        meeting_details: {
          topic: data.topic,
          start_time: data.start_time,
          timezone: data.timezone || 'America/Santiago'
        },
        metadata: {
          generated_at: new Date().toISOString(),
          source: 'Zoom Webhook Processor - Agente'
        }
      };

      try {
        const webhookUrl = process.env.N8N_AGENT_WEBHOOK_URL_START;
        if (webhookUrl) {
          console.log('[ZOOM-AGENTE] Enviando meeting.started a n8n...');
          await axios.post(webhookUrl, payloadToN8n, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
          });
          console.log('[ZOOM-AGENTE] Notificacion de inicio enviada');
        }
      } catch (err) {
        console.error('[ZOOM-AGENTE] Error enviando a n8n (inicio):', err.message);
      }
      return;
    }

    // Evento: reunion finalizada
    if (event === 'meeting.ended') {
      res.status(200).json({ success: true });

      const data = req.body.payload?.object;
      if (!data || !data.id) {
        console.error('[ZOOM-AGENTE] Payload invalido (meeting.ended)');
        return;
      }

      const payloadToN8n = {
        event: 'meeting.ended',
        account: 'agente',
        meeting_id: data.id,
        meeting_details: {
          topic: data.topic,
          start_time: data.start_time,
          end_time: data.end_time,
          duration: data.duration
        },
        metadata: {
          generated_at: new Date().toISOString(),
          source: 'Zoom Webhook Processor - Agente'
        }
      };

      try {
        const webhookUrl = process.env.N8N_AGENT_WEBHOOK_URL;
        if (webhookUrl) {
          console.log('[ZOOM-AGENTE] Enviando meeting.ended a n8n...');
          await axios.post(webhookUrl, payloadToN8n, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
          });
          console.log('[ZOOM-AGENTE] Datos de finalizacion enviados');
        }
      } catch (error) {
        console.error('[ZOOM-AGENTE] Error procesando meeting.ended:', error.message);
      }
      return;
    }

    // Evento: grabacion completada
    if (event === 'recording.completed') {
      res.status(200).json({ success: true });

      const data = req.body.payload?.object;
      if (!data || !data.id) {
        console.error('[ZOOM-AGENTE] Payload invalido (recording.completed)');
        return;
      }

      try {
        const recordingFiles = (data.recording_files || []).map(file => ({
          id: file.id,
          file_type: file.file_type,
          file_extension: file.file_extension,
          file_size: file.file_size,
          play_url: file.play_url,
          download_url: file.download_url,
          status: file.status,
          recording_start: file.recording_start,
          recording_end: file.recording_end,
          recording_type: file.recording_type
        }));

        const payloadToN8n = {
          event: 'recording.completed',
          account: 'agente',
          meeting_id: data.id,
          meeting_uuid: data.uuid,
          host_id: data.host_id,
          host_email: data.host_email,
          topic: data.topic,
          type: data.type,
          start_time: data.start_time,
          duration: data.duration,
          total_size: data.total_size,
          recording_count: data.recording_count,
          share_url: data.share_url,
          share_password: data.recording_play_passcode || null,
          recording_files: recordingFiles,
          download_token: req.body.download_token || null,
          metadata: {
            generated_at: new Date().toISOString(),
            source: 'Zoom Webhook Processor - Agente'
          }
        };

        const webhookUrl = process.env.N8N_AGENT_WEBHOOK_URL_RECORDING;
        if (webhookUrl) {
          console.log(`[ZOOM-AGENTE] Recording completed: ${data.topic}`);
          await axios.post(webhookUrl, payloadToN8n, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
          });
          console.log('[ZOOM-AGENTE] Recording data sent to n8n');
        }
      } catch (error) {
        console.error('[ZOOM-AGENTE] Error processing recording.completed:', error.message);
      }
      return;
    }

    // Otros eventos
    res.status(200).end();

  } catch (error) {
    console.error('[ZOOM-AGENTE] Error critico:', error.message);
    res.status(500).json({ error: 'Error interno', details: error.message });
  }
});

// ============================================================
// 🆕 ENDPOINTS WHATSAPP - ZOOM MASTER CONTROL
// ============================================================

/**
 * POST /whatsapp/incoming
 * 
 * Recibe mensajes de tu servidor whatsapp-web.js y los envía a n8n
 * para procesarlos con el sistema de comandos Zoom
 * 
 * Body esperado:
 * {
 *   "from": "5212345678@c.us",
 *   "message": "/ayuda",
 *   "timestamp": 1234567890 (opcional),
 *   "type": "chat" (opcional)
 * }
 */
app.post('/whatsapp/incoming', async (req, res) => {
  try {
    const { from, message, timestamp, type } = req.body;

    // Validar datos requeridos
    if (!from || !message) {
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos: from, message'
      });
    }

    console.log(`📱 [WHATSAPP] Mensaje de ${from}: ${message}`);

    // Verificar que esté configurado el webhook de n8n para WhatsApp
    if (!process.env.N8N_WEBHOOK_WHATSAPP) {
      console.error('❌ N8N_WEBHOOK_WHATSAPP no configurado');
      return res.status(500).json({
        success: false,
        error: 'Webhook de n8n para WhatsApp no configurado'
      });
    }

    // Preparar payload para n8n
    const payloadToN8n = {
      from: from,
      message: message,
      timestamp: timestamp || Date.now(),
      type: type || 'chat',
      metadata: {
        received_at: new Date().toISOString(),
        source: 'WhatsApp via Webhook Processor'
      }
    };

    // Enviar a n8n para procesar el comando
    const response = await axios.post(process.env.N8N_WEBHOOK_WHATSAPP, payloadToN8n, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });

    console.log('✅ [WHATSAPP] Mensaje enviado a n8n');

    res.json({
      success: true,
      message: 'Mensaje procesado',
      n8n_response: response.data
    });

  } catch (error) {
    console.error('❌ [WHATSAPP] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /whatsapp/send
 * 
 * Recibe solicitudes de n8n para enviar mensajes a WhatsApp
 * y las reenvía a tu servidor whatsapp-web.js
 * 
 * Body esperado:
 * {
 *   "to": "5212345678@c.us",
 *   "message": "Texto del mensaje"
 * }
 */
app.post('/whatsapp/send', async (req, res) => {
  try {
    const { to, message } = req.body;

    // Validar datos requeridos
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Faltan parámetros requeridos: to, message'
      });
    }

    console.log(`📤 [WHATSAPP] Enviando a ${to}: ${message.substring(0, 50)}...`);

    // Verificar que esté configurada la URL de WhatsApp
    if (!process.env.WHATSAPP_API_URL) {
      console.error('❌ WHATSAPP_API_URL no configurado');
      return res.status(500).json({
        success: false,
        error: 'URL de WhatsApp API no configurada'
      });
    }

    // Enviar mensaje a whatsapp-web.js
    const response = await axios.post(process.env.WHATSAPP_API_URL, {
      to: to,
      message: message
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log('✅ [WHATSAPP] Mensaje enviado');

    res.json({
      success: true,
      message: 'Mensaje enviado a WhatsApp'
    });

  } catch (error) {
    console.error('❌ [WHATSAPP] Error enviando:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// 🆕 ENDPOINTS ZOOM API DIRECTOS (para llamadas desde n8n)
// ============================================================

/**
 * GET /zoom/meetings
 * Lista reuniones programadas
 */
app.get('/zoom/meetings', async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();
    
    const response = await axios.get('https://api.zoom.us/v2/users/me/meetings', {
      params: {
        type: 'scheduled',
        page_size: 30
      },
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    res.json({
      success: true,
      meetings: response.data.meetings,
      total: response.data.total_records
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error listando reuniones:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /zoom/meetings
 * Crear nueva reunión
 * 
 * Body:
 * {
 *   "topic": "Mi reunión",
 *   "start_time": "2024-12-25T10:00:00",
 *   "duration": 60,
 *   "timezone": "America/Mexico_City"
 * }
 */
app.post('/zoom/meetings', async (req, res) => {
  try {
    const { topic, start_time, duration, timezone } = req.body;
    const accessToken = await getZoomAccessToken();

    const response = await axios.post('https://api.zoom.us/v2/users/me/meetings', {
      topic: topic || 'Nueva Reunión',
      type: 2, // Scheduled
      start_time: start_time,
      duration: duration || 60,
      timezone: timezone || 'America/Mexico_City',
      settings: {
        host_video: true,
        participant_video: true,
        waiting_room: true,
        auto_recording: 'cloud'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log(`✅ [ZOOM] Reunión creada: ${response.data.id}`);

    res.json({
      success: true,
      meeting: response.data
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error creando reunión:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /zoom/meetings/:id
 * Obtener detalles de una reunión
 */
app.get('/zoom/meetings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accessToken = await getZoomAccessToken();

    const response = await axios.get(`https://api.zoom.us/v2/meetings/${id}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    res.json({
      success: true,
      meeting: response.data
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error obteniendo reunión:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /zoom/meetings/:id
 * Modificar una reunión
 */
app.patch('/zoom/meetings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accessToken = await getZoomAccessToken();

    await axios.patch(`https://api.zoom.us/v2/meetings/${id}`, req.body, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log(`✅ [ZOOM] Reunión ${id} modificada`);

    res.json({
      success: true,
      message: 'Reunión actualizada'
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error modificando reunión:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /zoom/meetings/:id
 * Eliminar una reunión
 */
app.delete('/zoom/meetings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accessToken = await getZoomAccessToken();

    await axios.delete(`https://api.zoom.us/v2/meetings/${id}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    console.log(`✅ [ZOOM] Reunión ${id} eliminada`);

    res.json({
      success: true,
      message: 'Reunión eliminada'
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error eliminando reunión:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /zoom/webinars
 * Lista webinars programados
 */
app.get('/zoom/webinars', async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();

    const response = await axios.get('https://api.zoom.us/v2/users/me/webinars', {
      params: { page_size: 30 },
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    res.json({
      success: true,
      webinars: response.data.webinars,
      total: response.data.total_records
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error listando webinars:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /zoom/recordings
 * Lista grabaciones recientes (últimos 30 días)
 */
app.get('/zoom/recordings', async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();
    
    // Últimos 30 días
    const to = new Date().toISOString().split('T')[0];
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const from = fromDate.toISOString().split('T')[0];

    const response = await axios.get('https://api.zoom.us/v2/users/me/recordings', {
      params: {
        from: from,
        to: to,
        page_size: 30
      },
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    res.json({
      success: true,
      meetings: response.data.meetings,
      total: response.data.total_records
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error listando grabaciones:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /zoom/recordings/:id
 * Obtener grabaciones de una reunión específica
 */
app.get('/zoom/recordings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accessToken = await getZoomAccessToken();

    const response = await axios.get(`https://api.zoom.us/v2/meetings/${id}/recordings`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    res.json({
      success: true,
      recording: response.data
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error obteniendo grabación:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ENDPOINTS DE UTILIDAD
// ============================================================

/**
 * GET /status
 * Estado del servidor y configuración
 */
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    version: '2.0.0',
    endpoints: {
      zoom_webhook: '/webhook',
      whatsapp_incoming: '/whatsapp/incoming',
      whatsapp_send: '/whatsapp/send',
      zoom_meetings: '/zoom/meetings',
      zoom_webinars: '/zoom/webinars',
      zoom_recordings: '/zoom/recordings',
      recording_completed: '/webhook (event: recording.completed)',
      zoom_agent_webhook: '/webhook-agent'
    },
    config: {
      zoom_configured: !!process.env.ZOOM_CLIENT_ID,
      zoom_agent_configured: !!process.env.ZOOM_AGENT_WEBHOOK_SECRET_TOKEN,
      n8n_webhook_configured: !!process.env.N8N_WEBHOOK_URL,
      n8n_whatsapp_configured: !!process.env.N8N_WEBHOOK_WHATSAPP,
      n8n_recording_configured: !!process.env.N8N_WEBHOOK_URL_RECORDING,
      whatsapp_api_configured: !!process.env.WHATSAPP_API_URL
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /health
 * Health check simple
 */
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * GET /zoom/meetings
 * Lista SOLO reuniones FUTURAS (programadas)
 */
app.get('/zoom/meetings', async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();
    
    const response = await axios.get('https://api.zoom.us/v2/users/me/meetings', {
      params: {
        type: 'upcoming',  // 👈 SOLO FUTURAS
        page_size: 30
      },
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    // Filtrar adicional: solo fechas futuras
    const ahora = new Date();
    const futuras = (response.data.meetings || []).filter(m => {
      return new Date(m.start_time) > ahora;
    });

    res.json({
      success: true,
      meetings: futuras,
      total: futuras.length
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error listando reuniones:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /zoom/webinars
 * Lista SOLO webinars FUTUROS (programados)
 */
app.get('/zoom/webinars', async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();

    const response = await axios.get('https://api.zoom.us/v2/users/me/webinars', {
      params: {
        type: 'upcoming',  // 👈 SOLO FUTUROS
        page_size: 30
      },
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    // Filtrar adicional: solo fechas futuras
    const ahora = new Date();
    const futuros = (response.data.webinars || []).filter(w => {
      return new Date(w.start_time) > ahora;
    });

    res.json({
      success: true,
      webinars: futuros,
      total: futuros.length
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error listando webinars:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /zoom/webinars
 * Crear un nuevo webinar
 */
app.post('/zoom/webinars', async (req, res) => {
  try {
    const { topic, start_time, duration, agenda } = req.body;
    const accessToken = await getZoomAccessToken();

    const response = await axios.post('https://api.zoom.us/v2/users/me/webinars', {
      topic: topic || 'Nuevo Webinar',
      type: 5, // Webinar programado
      start_time: start_time,
      duration: duration || 90,
      timezone: 'America/Santiago',
      agenda: agenda || '',
      settings: {
        host_video: true,
        panelists_video: true,
        approval_type: 0, // Automático
        registration_type: 1,
        audio: 'both',
        auto_recording: 'cloud',
        enforce_login: false,
        close_registration: false,
        show_share_button: true,
        allow_multiple_devices: true
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    console.log(`✅ [ZOOM] Webinar creado: ${response.data.id}`);

    res.json({
      success: true,
      webinar: response.data
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error creando webinar:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.message || error.message 
    });
  }
});

/**
 * GET /zoom/webinars/:id
 * Obtener detalles de un webinar específico
 */
app.get('/zoom/webinars/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accessToken = await getZoomAccessToken();

    const response = await axios.get(`https://api.zoom.us/v2/webinars/${id}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    res.json({
      success: true,
      webinar: response.data
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error obteniendo webinar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /zoom/webinars/:id
 * Eliminar un webinar
 */
app.delete('/zoom/webinars/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const accessToken = await getZoomAccessToken();

    await axios.delete(`https://api.zoom.us/v2/webinars/${id}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });

    console.log(`✅ [ZOOM] Webinar ${id} eliminado`);

    res.json({
      success: true,
      message: 'Webinar eliminado'
    });

  } catch (error) {
    console.error('❌ [ZOOM] Error eliminando webinar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
app.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         🚀 ZOOM WEBHOOK PROCESSOR + WHATSAPP                 ║
╠══════════════════════════════════════════════════════════════╣
║  Puerto: ${port}                                               ║
║                                                              ║
║  📍 ENDPOINTS ZOOM:                                          ║
║     POST /webhook              - Eventos de Zoom             ║
║     GET  /zoom/meetings        - Listar reuniones            ║
║     POST /zoom/meetings        - Crear reunión               ║
║     GET  /zoom/meetings/:id    - Ver reunión                 ║
║     PATCH /zoom/meetings/:id   - Modificar reunión           ║
║     DELETE /zoom/meetings/:id  - Eliminar reunión            ║
║     GET  /zoom/webinars        - Listar webinars             ║
║     GET  /zoom/recordings      - Listar grabaciones          ║
║     GET  /zoom/recordings/:id  - Ver grabación               ║
║                                                              ║
║  📱 ENDPOINTS WHATSAPP:                                      ║
║     POST /whatsapp/incoming    - Recibir de WhatsApp         ║
║     POST /whatsapp/send        - Enviar a WhatsApp           ║
║                                                              ║
║  🔧 UTILIDADES:                                              ║
║     GET /status                - Estado del servidor         ║
║     GET /health                - Health check                ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
