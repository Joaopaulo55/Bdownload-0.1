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

const { execSync } = require('child_process');

// Verificar dependências ao iniciar
try {
  console.log('Verificando yt-dlp...');
  console.log(execSync('yt-dlp --version').toString());
  
  console.log('Verificando ffmpeg...');
  console.log(execSync('ffmpeg -version').toString());
} catch (error) {
  console.error('❌ Erro ao verificar dependências:', error);
  process.exit(1);
}

// Configurações essenciais para hospedagem
app.set('trust proxy', 1);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Rate Limit configurado corretamente
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Muitas requisições deste IP, tente novamente mais tarde.',
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip
});
app.use(limiter);

// Cria pasta de vídeos se não existir
if (!fs.existsSync('videos')) {
  fs.mkdirSync('videos');
}

// WebSocket
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    console.log('Received:', message);
  });
});

// Função para verificar se o yt-dlp está instalado
const checkYtDlpInstalled = (callback) => {
  exec('yt-dlp --version', (err, stdout, stderr) => {
    if (err || stderr) {
      console.error('yt-dlp não está instalado ou não está no PATH:', err || stderr);
      callback(false);
    } else {
      callback(true);
    }
  });
};

// Middleware para verificar yt-dlp
app.use('/info-video', (req, res, next) => {
  checkYtDlpInstalled((isInstalled) => {
    if (!isInstalled) {
      return res.status(500).json({ erro: 'yt-dlp não está instalado no servidor ou não está no PATH' });
    }
    next();
  });
});

app.use('/baixar', (req, res, next) => {
  checkYtDlpInstalled((isInstalled) => {
    if (!isInstalled) {
      return res.status(500).json({ erro: 'yt-dlp não está instalado no servidor ou não está no PATH' });
    }
    next();
  });
});

// Rota para informações do vídeo
app.post('/info-video', (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ erro: 'URL não fornecida' });

  const tryWithBrowserCookies = () => {
    const comando = `yt-dlp --cookies-from-browser chrome --dump-json --no-warnings "${url}"`;
    exec(comando, (erro, stdout, stderr) => {
      if (erro) {
        console.log('Falha com cookies do navegador, tentando com cookies.txt...');
        tryWithFileCookies();
      } else {
        processVideoInfo(stdout, res);
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
      processVideoInfo(stdout, res);
    });
  };

  const processVideoInfo = (stdout, res) => {
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

      res.json({
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
      });
    } catch (e) {
      res.status(500).json({ erro: 'Erro ao processar informações' });
    }
  };

  tryWithBrowserCookies();
});

// Rota para download
app.post('/baixar', (req, res) => {
  const { url, format, wsId } = req.body;
  if (!url) return res.status(400).json({ erro: 'URL não fornecida' });

  const formatOption = format ? `-f ${format}+bestaudio` : 'bestvideo+bestaudio';
  
  const tryDownload = (useFileCookies = false) => {
    const cookieOption = useFileCookies 
      ? '--cookies ./cookies.txt' 
      : '--cookies-from-browser chrome';
    
    const comando = `yt-dlp ${cookieOption} \
      --restrict-filenames \
      --merge-output-format mp4 \
      --newline \
      ${formatOption} \
      -o "videos/bdownload-%(title).50s-%(id)s.%(ext)s" \
      "${url}"`;

    const child = exec(comando);
    
    child.stdout.on('data', (data) => {
      const progressMatch = data.match(/\[download\]\s+(\d+\.\d+)%/);
      if (progressMatch && wsId) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.id === wsId) {
            client.send(JSON.stringify({ type: 'progress', value: progressMatch[1] }));
          }
        });
      }
      
      if (data.includes('100%')) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.id === wsId) {
            client.send(JSON.stringify({ type: 'complete' }));
          }
        });
      }
    });

    child.on('close', (code) => {
      if (code !== 0 && !useFileCookies) {
        console.log('Falha com cookies do navegador, tentando com cookies.txt...');
        tryDownload(true);
      } else {
        res.status(code === 0 ? 200 : 500).json({
          mensagem: code === 0 ? 'Download concluído!' : 'Erro durante o download'
        });
      }
    });
  };

  tryDownload();
});

// Rotas de listagem
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.get('/videos', (req, res) => {
  fs.readdir(path.join(__dirname, 'videos'), (err, files) => {
    res.json(err ? [] : files.filter(f => !f.startsWith('.')));
  });
});