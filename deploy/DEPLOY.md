# Deploy DYComment (Ubuntu + Docker + Nginx)

Tai lieu nay huong dan deploy DYComment thanh web chay production tren VPS Ubuntu.

## 1) Chuan bi VPS

Yeu cau:
- Ubuntu 22.04/24.04
- Co domain tro ve IP VPS (A record)

Cap nhat may:
```bash
sudo apt-get update
sudo apt-get -y upgrade
```

Mo firewall toi thieu:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

## 2) Cai Docker

```bash
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

## 3) Deploy source

```bash
sudo mkdir -p /opt/dycomment
sudo chown -R $USER:$USER /opt/dycomment
cd /opt/dycomment
git clone <REPO_URL> .
```

Tao `.env`:
```bash
cp .env.example .env
```

Goi y cau hinh production:
- `PORT=3000`
- `PLAYWRIGHT_HEADLESS=true`
- `OFFLINE_DICT_DIR=/app/dict` (neu ban mount dict vao container)
- `GEMINI_API_KEY=` neu dung Gemini

Neu muon dung offline dictionary:
```bash
mkdir -p dict
```
Roi copy du lieu tu dien vao thu muc `/opt/dycomment/dict`.

## 4) Chay container

Build va chay:
```bash
docker compose up -d --build
```

Kiem tra:
```bash
docker compose ps
curl -s http://127.0.0.1:3000/api/health | head
```

## 5) Reverse proxy bang Nginx

```bash
sudo apt-get install -y nginx
```

Tao site config:
```bash
sudo cp /opt/dycomment/deploy/nginx-site.conf /etc/nginx/sites-available/dycomment
sudo sed -i 's/server_name example.com;/server_name YOUR_DOMAIN;/' /etc/nginx/sites-available/dycomment
sudo ln -sf /etc/nginx/sites-available/dycomment /etc/nginx/sites-enabled/dycomment
sudo nginx -t
sudo systemctl reload nginx
```

## 6) HTTPS (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

## 7) Luu y quan trong ve Douyin cookie trong production

- Comment top-level cong khai co the chay voi guest cookie (backend tu bootstrap), khong can dang nhap.
- Reply co the bi Douyin chan verify/captcha theo IP hoac theo session.
- Nut `Sync cookies Douyin` se mo browser de dang nhap. Tren VPS khong co GUI thi kho dung.

Neu ban that su can reply dang nhap trong production:
- Cach on nhat: dang nhap va sync cookie tren may co GUI, sau do copy file `.cache/douyin-storage-state.json` len server vao `/opt/dycomment/.cache/` (volume da mount).

## 8) Update phien ban

```bash
cd /opt/dycomment
git pull
docker compose up -d --build
```
