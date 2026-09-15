#!/usr/bin/env bash
# ขึ้นระบบสต็อก
#
#   ./deploy.sh          ขึ้น environment เริ่มต้น (มินตรา)
#   ./deploy.sh <ชื่อ>   ขึ้น environment ที่ระบุ
set -euo pipefail
cd "$(dirname "$0")/worker"

target="${1:-}"
if [ -z "$target" ]; then
  echo "▸ สต็อก มินตรา (ค่าเริ่มต้น)"
  npx wrangler deploy
else
  echo "▸ สต็อก $target"
  npx wrangler deploy -e "$target"
fi
