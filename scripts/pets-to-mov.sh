#!/usr/bin/env bash
# Converts pet WebM (VP9 alpha) → MOV (HEVC with alpha) so iOS Safari can
# render the pets with proper transparency. iOS decodes the WebM stream
# but drops the alpha plane, so the studio black bg shows up as a box
# around every pet — the .mov path uses VideoToolbox HEVC alpha which
# iOS handles correctly.
#
# WHY .webm AS SOURCE: the .webm files already carry clean alpha
# (encoded from .mp4/.mov masters with chromakey). Re-using that alpha
# avoids re-running the chroma-key step. The .mp4 sources have no alpha
# at all — converting from those would mean re-keying every pet.
#
# REQUIRES: macOS + ffmpeg (brew install ffmpeg). The hevc_videotoolbox
# encoder is part of Apple's framework on macOS — not available on
# Windows/Linux ffmpeg builds.
#
# RUN FROM yuna-teach/:
#   chmod +x scripts/pets-to-mov.sh
#   ./scripts/pets-to-mov.sh
#
# AFTER RUNNING:
#   1. bump ASSET_VERSION in src/app/habitats/[userId]/page.tsx
#   2. git add the new public/avatars/*.mov files
#   3. commit + push

set -euo pipefail

PETS=(pangolin boar merlion dragon qilin unicorn whitetiger)
CLIPS=(smile stretch walk talk)
AVATARS_DIR="public/avatars"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found — install with: brew install ffmpeg" >&2
  exit 1
fi

if [[ ! -d "$AVATARS_DIR" ]]; then
  echo "$AVATARS_DIR not found — run this script from the yuna-teach/ root" >&2
  exit 1
fi

count=0
for pet in "${PETS[@]}"; do
  for clip in "${CLIPS[@]}"; do
    src="${AVATARS_DIR}/${pet}_${clip}.webm"
    dst="${AVATARS_DIR}/${pet}_${clip}.mov"
    if [[ ! -f "$src" ]]; then
      echo "skip: missing $src"
      continue
    fi
    echo "[$pet $clip] $(basename "$src") → $(basename "$dst")"
    # -c:v libvpx-vp9   force VP9 decoder so the alpha plane is exposed
    #                   (default may pick a decoder that drops it).
    # -c:v hevc_videotoolbox  Apple HEVC encoder, supports alpha.
    # -allow_sw 1       fall back to software encode if hardware path is
    #                   unavailable for alpha on this Mac.
    # -alpha_quality 0.75  good balance — 1.0 doubles file size.
    # -tag:v hvc1       Apple-friendly tag so QuickTime/Safari picks the
    #                   right codec path (the default 'hev1' tag is
    #                   sometimes not honoured by Safari).
    ffmpeg -y -hide_banner -loglevel warning \
      -c:v libvpx-vp9 -i "$src" \
      -c:v hevc_videotoolbox \
      -allow_sw 1 \
      -alpha_quality 0.75 \
      -tag:v hvc1 \
      -an \
      "$dst"
    count=$((count + 1))
  done
done

echo ""
echo "Converted $count clips."
echo "Next: bump ASSET_VERSION in src/app/habitats/[userId]/page.tsx so browsers refetch."
