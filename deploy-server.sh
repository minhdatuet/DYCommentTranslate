#!/bin/bash
set -e

echo "======================================================"
echo "   DYComment - Deployment Script (Hunyuan 1.8B)      "
echo "======================================================"

# 1. Cap nhat va cai dat Docker
echo "[1/5] Installing Docker & Dependencies..."
sudo apt-get update
sudo apt-get install -y docker.io docker-compose git curl

# 2. Clone Code
echo "[2/5] Cloning repository..."
if [ -d "DYCommentTranslate" ]; then
    cd DYCommentTranslate
    git pull
else
    git clone https://github.com/minhdatuet/DYCommentTranslate.git
    cd DYCommentTranslate
fi

# 3. Thiet lap moi truong
echo "[3/5] Setting up environment..."
if [ ! -f ".env" ]; then
    cp .env.example .env
fi

# 4. Tai Model (1.1GB)
echo "[4/5] Downloading Model HY-MT 1.8B GGUF (This may take a while)..."
mkdir -p models
if [ ! -f "models/hy-mt-1.5-1.8b.gguf" ]; then
    curl -L "https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/HY-MT1.5-1.8B-Q4_K_M.gguf?download=true" -o "models/hy-mt-1.5-1.8b.gguf"
else
    echo "Model already exists, skipping download."
fi

# 5. Khoi dong Docker Compose
echo "[5/5] Starting Docker containers..."
sudo docker-compose up -d --build

echo "======================================================"
echo "   DEPLOYMENT COMPLETE!                              "
echo "   Access your app at: http://your-server-ip:3000    "
echo "======================================================"
