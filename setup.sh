#!/bin/bash

echo "🔄 Instalando yt-dlp..."
python -m pip install --upgrade yt-dlp

echo "🔄 Verificando instalação do yt-dlp..."
yt-dlp --version

echo "🔄 Instalando ffmpeg..."
apt-get update && apt-get install -y ffmpeg

echo "🔄 Verificando instalação do ffmpeg..."
ffmpeg -version

echo "✅ Dependências instaladas com sucesso!"
