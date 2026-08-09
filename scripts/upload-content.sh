#!/usr/bin/env bash
set -euo pipefail

# Cliente de ejemplo para la API de migración. Envía los ficheros uno a uno y
# cada fichero por fragmentos, sin leerlo entero en memoria.

required=(MOODLESHIELD_URL CONTENT_API_TOKEN PLATFORM_ID OWNER_SUB)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Falta la variable $name" >&2
    exit 2
  fi
done
if [[ $# -eq 0 ]]; then
  echo "Uso: MOODLESHIELD_URL=... CONTENT_API_TOKEN=... PLATFORM_ID=... OWNER_SUB=... $0 fichero [...]" >&2
  exit 2
fi
for command in curl jq; do
  command -v "$command" >/dev/null || { echo "Falta el comando $command" >&2; exit 2; }
done

base_url=${MOODLESHIELD_URL%/}
headers=(
  -H "Authorization: Bearer $CONTENT_API_TOKEN"
  -H "X-MoodleShield-Platform-Id: $PLATFORM_ID"
  -H "X-MoodleShield-Owner-Sub: $OWNER_SUB"
)
if [[ -n "${OWNER_NAME:-}" ]]; then
  headers+=(-H "X-MoodleShield-Owner-Name: $OWNER_NAME")
fi

file_size () {
  if stat -f '%z' "$1" >/dev/null 2>&1; then stat -f '%z' "$1"
  else stat -c '%s' "$1"
  fi
}

kind_for () {
  lower_name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$lower_name" in
    *.pdf) echo pdf ;;
    *.mp4|*.mov|*.mkv|*.m4v|*.webm|*.avi) echo video ;;
    *) echo "Extensión no soportada: $1" >&2; return 1 ;;
  esac
}

for file in "$@"; do
  [[ -f "$file" ]] || { echo "No es un fichero: $file" >&2; exit 2; }
  filename=$(basename "$file")
  kind=$(kind_for "$filename")
  size=$(file_size "$file")
  title=${filename%.*}

  echo "Reservando: $filename ($size bytes, $kind)" >&2
  reservation=$(curl --fail-with-body --silent --show-error \
    "${headers[@]}" -H 'Content-Type: application/json' \
    -X POST "$base_url/api/v1/uploads" \
    --data "$(jq -cn --arg kind "$kind" --arg filename "$filename" \
      --arg title "$title" --argjson size "$size" \
      '{kind:$kind,filename:$filename,title:$title,size:$size}')")

  upload_id=$(jq -er '.uploadId' <<<"$reservation")
  material_id=$(jq -er '.materialId' <<<"$reservation")
  chunk_bytes=$(jq -er '.chunkBytes' <<<"$reservation")
  chunk_count=$(jq -er '.chunkCount' <<<"$reservation")

  for ((index=0; index<chunk_count; index++)); do
    offset=$((index * chunk_bytes))
    remaining=$((size - offset))
    expected=$chunk_bytes
    (( remaining < expected )) && expected=$remaining
    echo "  fragmento $((index + 1))/$chunk_count" >&2
    dd if="$file" bs="$chunk_bytes" skip="$index" count=1 2>/dev/null | \
      curl --fail-with-body --silent --show-error \
        "${headers[@]}" -H 'Content-Type: application/octet-stream' \
        -H "Content-Length: $expected" \
        -X PUT "$base_url/api/v1/uploads/$upload_id/chunks/$index" \
        --data-binary @- >/dev/null
  done

  result=$(curl --fail-with-body --silent --show-error \
    "${headers[@]}" -H 'Content-Type: application/json' \
    -X POST "$base_url/api/v1/uploads/$upload_id/complete" --data '{}')
  revision_id=$(jq -er '.revisionId' <<<"$result")
  echo "Encolado: material=$material_id revision=$revision_id" >&2
  jq -n --arg file "$file" --arg kind "$kind" --arg id "$material_id" \
    --arg revisionId "$revision_id" \
    '{file:$file,kind:$kind,id:$id,revisionId:$revisionId,status:"queued"}'
done
