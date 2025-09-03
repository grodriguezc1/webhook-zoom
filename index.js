require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios'); // Agregado para forwarding a n8n

const app = express();
const port = process.env.PORT || 4000;

app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.status(200);
  res.send(`Zoom Webhook sample successfully running. Set this URL with the /webhook path as your apps Event notification endpoint URL. https://github.com/zoom/webhook-sample`);
});

app.post('/webhook', (req, res) => {
  var response;

  console.log(req.headers);
  console.log(req.body);

  // construct the message string
  const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;

  const hashForVerify = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(message).digest('hex');

  // hash the message string with your Webhook Secret Token and prepend the version semantic
  const signature = `v0=${hashForVerify}`;

  // you validating the request came from Zoom https://marketplace.zoom.us/docs/api-reference/webhook-reference#notification-structure
  if (req.headers['x-zm-signature'] === signature) {

    // Zoom validating you control the webhook endpoint https://marketplace.zoom.us/docs/api-reference/webhook-reference#validate-webhook-endpoint
    if (req.body.event === 'endpoint.url_validation') {
      const hashForValidate = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(req.body.payload.plainToken).digest('hex');

      response = {
        message: {
          plainToken: req.body.payload.plainToken,
          encryptedToken: hashForValidate
        },
        status: 200
      };

      console.log(response.message);
      res.status(response.status);
      res.json(response.message);
    } else {
      response = { message: 'Authorized request to Zoom Webhook sample.', status: 200 };
      console.log(response.message);
      res.status(response.status);
      res.json(response);

      // business logic here: forwarding to n8n for specific events
      if (req.body.event === 'meeting.started') {
        // Ejecuta comandos previos aquí si necesitas (e.g., child_process.exec)
        // Ejemplo: console.log('Ejecutando comandos antes de start...');

        axios.post(process.env.N8N_WEBHOOK_URL_START, req.body)
          .then(() => console.log('Enviado a n8n start'))
          .catch(err => console.error('Error enviando a n8n start:', err));
      } else if (req.body.event === 'meeting.ended') {
        // Ejecuta comandos previos aquí si necesitas
        // Ejemplo: console.log('Ejecutando comandos antes de end...');

        axios.post(process.env.N8N_WEBHOOK_URL, req.body)
          .then(() => console.log('Enviado a n8n end'))
          .catch(err => console.error('Error enviando a n8n end:', err));
      }
    }
  } else {
    response = { message: 'Unauthorized request to Zoom Webhook sample.', status: 401 };
    console.log(response.message);
    res.status(response.status);
    res.json(response);
  }
});

app.listen(port, () => console.log(`Zoom Webhook sample listening on port ${port}!`));
