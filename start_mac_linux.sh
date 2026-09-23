#!/usr/bin/env sh
cd "$(dirname "$0")"
echo "Brivviant Studio starting on http://localhost:8080"
python3 -m http.server 8080
