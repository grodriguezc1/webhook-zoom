// ... (código anterior se mantiene igual hasta la función getAllParticipants)

// Nueva función para obtener registrados
async function getRegistrants(webinarId) {
  let allRegistrants = [];
  let nextPageToken = null;
  let pageCount = 0;
  const baseUrl = `https://api.zoom.us/v2/webinars/${webinarId}/registrants`;

  const accessToken = await getZoomAccessToken();
  console.log('🔑 Token OAuth obtenido para registrantes');

  do {
    pageCount++;
    console.log(`📖 Obteniendo página ${pageCount} de registrados...`);
    
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

// ... (código anterior se mantiene igual hasta el handler del webhook)

    if (req.body.event === 'webinar.ended') {
      res.status(200).json({ success: true });
      
      if (!req.body.payload.object || !req.body.payload.object.id) {
        console.error('❌ Estructura de payload inválida');
        return;
      }

      const webinarInfo = req.body.payload.object;
      const webinarId = webinarInfo.id;
      
      try {
        // Obtener ambos conjuntos de datos en paralelo
        const [participants, registrants] = await Promise.all([
          getAllParticipants(webinarId),
          getRegistrants(webinarId)
        ]);

        console.log(`📊 Estadísticas:
        👥 Participantes: ${participants.length}
        📝 Registrados: ${registrants.length}`);

        // Encontrar registrados que no asistieron
        const attendedEmails = new Set(participants.map(p => p.email?.toLowerCase()));
        const noShows = registrants.filter(
          r => !attendedEmails.has(r.email?.toLowerCase())
        );

        // Construir payload completo
        const payloadToN8N = {
          event: 'webinar.ended',
          payload: {
            webinar_info: {
              id: webinarId,
              topic: webinarInfo.topic,
              start_time: webinarInfo.start_time,
              end_time: webinarInfo.end_time
            },
            statistics: {
              total_participants: participants.length,
              total_registrants: registrants.length,
              attendance_rate: registrants.length > 0 
                ? (participants.length / registrants.length * 100).toFixed(2) + '%'
                : '0%'
            },
            participants: participants,
            registrants: registrants,
            no_shows: noShows
          }
        };

        console.log(`🔄 Enviando datos completos a n8n...`);
        await axios.post(process.env.N8N_WEBHOOK_URL, payloadToN8N, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        
        console.log('✅ Todos los datos enviados exitosamente');
      } catch (error) {
        console.error('⚠️ Error:', error.message);
      }
      return;
    }

// ... (resto del código se mantiene igual)
