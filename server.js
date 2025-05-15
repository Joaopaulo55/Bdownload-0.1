require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');
const LRU = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache para informações de vídeo (1 hora de tempo de vida)
const videoInfoCache = new LRU({
  max: 100,
  maxAge: 1000 * 60 * 60
});

// Verificar dependências ao iniciar
try {
  console.log('Verificando yt-dlp...');
  require('child_process').execSync('yt-dlp --version').toString();
  
  console.log('Verificando ffmpeg...');
  require('child_process').execSync('ffmpeg -version').toString();
} catch (error) {
  console.error('❌ Erro ao verificar dependências:', error);
  process.exit(1);
}

// Configurações essenciais
app.set('trust proxy', 1);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Rate Limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Muitas requisições deste IP, tente novamente mais tarde.',
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip
});
app.use(limiter);

// WebSocket
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
const wss = new WebSocket.Server({ server });

// Sistema de fila de downloads
const downloadQueue = [];
let isProcessingQueue = false;

// Processar fila de downloads
const processQueue = () => {
  if (isProcessingQueue || downloadQueue.length === 0) return;
  
  isProcessingQueue = true;
  const { res, url, format, wsId } = downloadQueue.shift();
  
  const formatOption = format ? `-f ${format}+bestaudio` : 'bestvideo+bestaudio';
  const sanitizedUrl = url.replace(/"/g, '\\"');
  
  // Configurações comuns para yt-dlp
  const commonOptions = [
    '--restrict-filenames',
    '--merge-output-format mp4',
    '--newline',
    formatOption,
    '-o -' // Saída para stdout
  ];
  
  const tryDownload = (useFileCookies = false) => {
    const cookieOption = useFileCookies 
      ? '--cookies ./cookies.txt' 
      : '--cookies-from-browser chrome';
    
    const comando = `yt-dlp ${cookieOption} ${commonOptions.join(' ')} "${sanitizedUrl}"`;
    
    const child = exec(comando, { maxBuffer: 1024 * 1024 * 50 }); // 50MB buffer
    
    // Configurar headers para streaming
    res.setHeader('Content-Disposition', `attachment; filename="${getFilename(url, format)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    
    child.stdout.on('data', (data) => {
      res.write(data); // Stream direto para o cliente
      
      const progressMatch = data.toString().match(/\[download\]\s+(\d+\.\d+)%/);
      if (progressMatch && wsId) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.id === wsId) {
            client.send(JSON.stringify({ type: 'progress', value: progressMatch[1] }));
          }
        });
      }
    });
    
    child.on('close', (code) => {
      res.end();
      
      if (code !== 0 && !useFileCookies) {
        console.log('Falha com cookies do navegador, tentando com cookies.txt...');
        tryDownload(true);
      } else {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.id === wsId) {
            client.send(JSON.stringify({ type: 'complete' }));
          }
        });
      }
      
      isProcessingQueue = false;
      process.nextTick(processQueue);
    });
    
    child.on('error', (err) => {
      console.error('Erro no download:', err);
      res.status(500).json({ erro: 'Erro durante o download' });
      isProcessingQueue = false;
      process.nextTick(processQueue);
    });
  };
  
  tryDownload();
};

// Gerar nome de arquivo amigável
const getFilename = (url, format) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const type = format && format.includes('audio') ? 'audio' : 'video';
  return `download-${type}-${timestamp}.mp4`;
};

// Rota para informações do vídeo (com cache)
app.post('/info-video', (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ erro: 'URL não fornecida' });
  
  // Verificar cache primeiro
  const cachedInfo = videoInfoCache.get(url);
  if (cachedInfo) {
    return res.json(cachedInfo);
  }
  
  const tryWithBrowserCookies = () => {
    const comando = `yt-dlp --cookies-from-browser chrome --dump-json --no-warnings "${url}"`;
    exec(comando, (erro, stdout, stderr) => {
      if (erro) {
        console.log('Falha com cookies do navegador, tentando com cookies.txt...');
        tryWithFileCookies();
      } else {
        processVideoInfo(stdout, res, url);
      }
    });
  };
  
  const tryWithFileCookies = () => {
    const comando = `yt-dlp --cookies ./cookies.txt --dump-json --no-warnings "${url}"`;
    exec(comando, (erro, stdout, stderr) => {
      if (erro) {
        return res.status(500).json({ 
          erro: 'Falha ao obter informações',
          detalhes: stderr.toString()
        });
      }
      processVideoInfo(stdout, res, url);
    });
  };
  
  const processVideoInfo = (stdout, res, url) => {
    try {
      const info = JSON.parse(stdout);
      const formats = info.formats
        .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
        .filter(f => !f.format_note?.includes('DASH'))
        .reduce((acc, f) => {
          const key = f.vcodec !== 'none' ? `video-${f.height || '0'}` : `audio-${f.abr || '0'}`;
          if (!acc[key] || (f.filesize && f.filesize > acc[key].filesize)) {
            acc[key] = f;
          }
          return acc;
        }, {});

      const result = {
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
      
      // Armazenar no cache
      videoInfoCache.set(url, result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ erro: 'Erro ao processar informações' });
    }
  };
  
  tryWithBrowserCookies();
});

// Rota para download (com fila)
app.post('/baixar', (req, res) => {
  const { url, format, wsId } = req.body;
  if (!url) return res.status(400).json({ erro: 'URL não fornecida' });
  
  // Adicionar à fila
  downloadQueue.push({ res, url, format, wsId });
  
  // Informar posição na fila
  const position = downloadQueue.length;
  if (wsId) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.id === wsId) {
        client.send(JSON.stringify({ 
          type: 'queue', 
          position,
          message: position > 1 ? 
            `Seu download está na posição ${position} da fila` : 
            'Seu download começará em breve'
        }));
      }
    });
  }
  
  // Processar fila se não estiver sendo processada
  if (!isProcessingQueue) {
    processQueue();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// WebSocket connection
wss.on('connection', (ws) => {
  ws.id = 'ws-' + Math.random().toString(36).substr(2, 9);
  
  ws.on('message', (message) => {
    console.log('Received:', message);
  });
});