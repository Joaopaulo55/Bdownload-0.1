require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Muitas requisições deste IP, tente novamente mais tarde.'
});

app.use(cors());
app.use(bodyParser.json());
app.use(limiter);
app.use(express.static('public'));
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Tratamento de erros global
process.on('uncaughtException', (err) => {
  console.error('Erro não tratado:', err);
});

// Configuração do WebSocket
const server = app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    console.log('Received:', message);
  });
});

// Verificação simplificada de espaço em disco
async function verifyStorage() {
  try {
    const stats = fs.statfsSync('/');
    const freeSpace = stats.bfree * stats.bsize;
    return freeSpace > 100 * 1024 * 1024; // 100MB mínimo
  } catch (err) {
    console.error('Erro ao verificar espaço:', err);
    return true; // Permite continuar mesmo com erro
  }
}

// Rota para obter informações do vídeo
app.post('/info-video', async (req, res) => {
  try {
    const url = req.body.url;
    if (!url) {
      return res.status(400).json({ erro: 'URL não fornecida' });
    }

    if (!await verifyStorage()) {
      return res.status(500).json({ erro: 'Espaço em disco insuficiente' });
    }

    const comando = `yt-dlp --dump-json --no-warnings "${url}"`;
    exec(comando, (erro, stdout, stderr) => {
      if (erro) {
        return res.status(500).json({ erro: stderr || 'Erro ao obter informações do vídeo' });
      }
      
      try {
        const info = JSON.parse(stdout);
        
        const formats = info.formats
          .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
          .filter(f => !f.format_note?.includes('DASH'))
          .reduce((acc, f) => {
            const key = f.vcodec !== 'none' ? 
              `video-${f.height || '0'}` : 
              `audio-${f.abr || '0'}`;
            
            if (!acc[key] || (f.filesize && (!acc[key].filesize || f.filesize > acc[key].filesize))) {
              acc[key] = f;
            }
            return acc;
          }, {});

        const simplifiedInfo = {
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
          formats: Object.values(formats).map(f => ({
            format_id: f.format_id,
            ext: f.ext,
            vcodec: f.vcodec,
            acodec: f.acodec,
            height: f.height,
            filesize: f.filesize,
            type: f.vcodec !== 'none' ? 'video' : 'audio'
          }))
        };
        return res.json(simplifiedInfo);
      } catch (parseError) {
        return res.status(500).json({ erro: 'Erro ao processar informações do vídeo' });
      }
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Rota para baixar o vídeo
app.post('/baixar', async (req, res) => {
  try {
    const { url, format, wsId } = req.body;
    if (!url) {
      return res.status(400).json({ erro: 'URL não fornecida' });
    }

    if (!await verifyStorage()) {
      return res.status(500).json({ erro: 'Espaço em disco insuficiente' });
    }

    const formatOption = format ? `-f ${format}+bestaudio` : 'bestvideo+bestaudio';
    const comando = `yt-dlp --cookies ./cookies.txt \
      --restrict-filenames \
      --merge-output-format mp4 \
      --newline \
      ${formatOption} \
      -o "videos/bdownload.com-%(title).50s-%(id)s.%(ext)s" \
      --exec "echo Download concluído: {}" \
      "${url}"`;
    
    const child = exec(comando);
    
    child.stdout.on('data', (data) => {
      const progressMatch = data.match(/\[download\]\s+(\d+\.\d+)%/);
      if (progressMatch) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.id === wsId) {
            client.send(JSON.stringify({ type: 'progress', value: progressMatch[1] }));
          }
        });
      }
      
      if (data.includes('Download concluído:')) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.id === wsId) {
            client.send(JSON.stringify({ type: 'complete' }));
          }
        });
      }
    });

    child.stderr.on('data', (data) => {
      console.error('Erro no yt-dlp:', data);
    });

    child.on('close', (code) => {
      if (code === 0) {
        res.json({ mensagem: 'Download concluído com sucesso!' });
      } else {
        res.status(500).json({ erro: 'Erro durante o download. Verifique se o vídeo possui áudio disponível.' });
      }
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Rota para listar vídeos baixados
app.get('/videos', (req, res) => {
  fs.readdir(path.join(__dirname, 'videos'), (err, files) => {
    if (err) {
      return res.status(500).json({ erro: 'Erro ao ler pasta de vídeos' });
    }
    res.json(files.filter(file => !file.startsWith('.')));
  });
});

// Rota para busca de vídeos
app.get('/videos/search', (req, res) => {
  const query = req.query.q?.toLowerCase();
  if (!query) {
    return res.status(400).json({ erro: 'Termo de busca não fornecido' });
  }

  fs.readdir(path.join(__dirname, 'videos'), (err, files) => {
    if (err) {
      return res.status(500).json({ erro: 'Erro ao ler pasta de vídeos' });
    }
    
    const results = files.filter(file => 
      !file.startsWith('.') && 
      file.toLowerCase().includes(query)
    );
    
    res.json(results);
  });
});