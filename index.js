require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.status(200).send('Servidor de webhooks activo');
});

// Procesamiento de webhooks
app.post('/webhook', async (req, res) => {
  console.log('📩 Evento recibido:', req.body.event);

  // 1. Validar firma de Zoom
  const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
  const hash = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(message)
    .digest('hex');

  if (`v0=${hash}` !== req.headers['x-zm-signature']) {
    console.error('❌ Firma inválida');
    return res.status(401).send('Firma no válida');
  }

  // 2. Validación inicial de Zoom
  if (req.body.event === 'endpoint.url_validation') {
    const responseToken = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(req.body.payload.plainToken)
      .digest('hex');

    return res.json({
      plainToken: req.body.payload.plainToken,
      encryptedToken: responseToken
    });
  }

  // 3. Filtrar solo eventos de webinar terminado
  if (req.body.event !== 'webinar.ended') {
    return res.status(200).json({ message: 'Evento no procesado' });
  }

  // 4. Reenviar a n8n
  const n8nUrl = process.env.N8N_WEBHOOK_URL;
  
  if (!n8nUrl) {
    console.error('❌ URL de n8n no configurada');
    return res.status(500).send('Error de configuración');
  }

  try {
    console.log(`🔄 Enviando a n8n: ${n8nUrl}`);
    
    await axios.post(n8nUrl, {
      zoomWebhook: req.body
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000
    });

    console.log('✅ Evento enviado correctamente');
    res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error al enviar a n8n:', error.message);
    res.status(502).json({
      error: 'Error al reenviar el webhook',
      details: error.message
    });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en puerto ${port}`);
});
