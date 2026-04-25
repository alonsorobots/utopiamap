#!/bin/bash
# Upload PMTiles to Cloudflare R2 for production serving
#
# Prerequisites:
#   1. Create a Cloudflare R2 bucket named "utopia-tiles"
#   2. Create an API token with R2 read/write permissions
#   3. Set environment variables:
#      export CF_ACCOUNT_ID="your-account-id"
#      export R2_ACCESS_KEY_ID="your-access-key"
#      export R2_SECRET_ACCESS_KEY="your-secret-key"
#   4. Install rclone: brew install rclone
#
# Configure rclone:
#   rclone config create r2 s3 \
#     provider Cloudflare \
#     access_key_id "$R2_ACCESS_KEY_ID" \
#     secret_access_key "$R2_SECRET_ACCESS_KEY" \
#     endpoint "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
#     acl private
#
# Usage:
#   ./pipeline/upload_to_r2.sh

set -e

TILES_DIR="$(dirname "$0")/../data/tiles"
BUCKET="r2:utopia-tiles"

echo "Uploading tiles to Cloudflare R2..."
echo "Source: $TILES_DIR"
echo "Dest:   $BUCKET"

# Use `copy` (not `sync`) so we never delete tiles in R2 that aren't present
# locally. Different machines may build different subsets of tiles, and the
# bucket is the merged superset. The catalog.json should always be a full
# manifest of everything in R2.
rclone copy "$TILES_DIR" "$BUCKET" \
  --include "*.pmtiles" \
  --include "catalog.json" \
  --copy-links \
  --progress \
  --transfers 8 \
  --checkers 16

echo ""
echo "Done! Configure your R2 bucket with:"
echo "  - Custom domain: tiles.your-domain.com"
echo "  - CORS: Allow-Origin *, Accept-Ranges bytes"
echo "  - Public access enabled"
echo ""

TOTAL=$(du -sh "$TILES_DIR" 2>/dev/null | cut -f1)
echo "Total uploaded: $TOTAL"
