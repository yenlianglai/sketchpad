#!/bin/sh
# Self-signed cert so iPad Safari allows getUserMedia (mic) over the LAN.
# Usage: sh scripts/gen-cert.sh [extra-ip-or-hostname ...]
set -e
cd "$(dirname "$0")/.."
mkdir -p certs
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
SAN="DNS:localhost,IP:127.0.0.1,IP:$IP"
for extra in "$@"; do
  case "$extra" in
    *[a-zA-Z]*) SAN="$SAN,DNS:$extra" ;;
    *) SAN="$SAN,IP:$extra" ;;
  esac
done
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=sketchpad" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=CA:TRUE" \
  -addext "keyUsage=digitalSignature,keyEncipherment,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth"
echo "cert written to certs/server.crt with SAN: $SAN"
echo "Install certs/server.crt on the iPad (AirDrop -> Settings > General > VPN & Device Management -> install),"
echo "then enable full trust in Settings > General > About > Certificate Trust Settings."
