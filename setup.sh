#!/bin/bash

# Atualizar pacotes do sistema
echo "🔄 Atualizando pacotes do sistema..."
apt-get update -y

# Instalar dependências do sistema
echo "🔄 Instalando dependências do sistema..."
apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    git \
    build-essential

# Instalar yt-dlp
echo "🔄 Instalando yt-dlp..."
python3 -m pip install --upgrade yt-dlp

# Verificar yt-dlp
echo "🔄 Verificando instalação do yt-dlp..."
yt-dlp --version

# Verificar ffmpeg
echo "🔄 Verificando instalação do ffmpeg..."
ffmpeg -version

# Instalar dependências do Node.js (caso não estejam no package.json)
echo "🔄 Instalando dependências globais do Node.js..."
npm install -g \
    npm@latest \
    pm2

# Instalar dependências do projeto
echo "🔄 Instalando dependências do projeto..."
npm install \
    express \
    body-parser \
    cors \
    ws \
    lru-cache \
    express-rate-limit \
    dotenv

# Limpar cache para economizar espaço
echo "🔄 Limpando cache..."
apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

echo "✅ Todas as dependências instaladas com sucesso!"
