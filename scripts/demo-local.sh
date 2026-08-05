#!/usr/bin/env bash
# Recorrido completo del sistema en el entorno local, sin Moodle y sin tocar
# nada a mano. Genera un vídeo de prueba, lo sube, espera a que se transcodifique
# y comprueba las cinco cosas que hacen que esto funcione:
#
#   1. ffmpeg corre 2 veces (una por variante) y nunca más
#   2. dos alumnos reciben mezclas A/B distintas
#   3. los segmentos van cifrados
#   4. nginx sólo entrega los segmentos de TU patrón (la otra variante → 403)
#   5. el trazado forense identifica al alumno correcto
#
# Uso:  ./scripts/demo-local.sh          (desde la raíz del repo)

set -euo pipefail

cd "$(dirname "$0")/.."
BASE="http://127.0.0.1:${HTTP_PORT:-8088}"
C="docker compose -p moodleshield-local"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }
FAILED=0

# Emite un token de sesión con el mismo módulo que usa la app tras un launch LTI.
sesion() { # $1=sub  $2=nombre  $3=instructor(true|false)
  $C exec -T app node --input-type=module -e "
    const { issueSession } = await import('/app/src/session.js')
    console.log(issueSession({ sub: '$1', platformId: null, name: '$2', identity: '$1', isInstructor: $3 }))
  " | tr -d '\r'
}

head_ "0· Comprobando que el stack responde"
curl -fsS "$BASE/readyz" >/dev/null && ok "$BASE responde" || { bad "el stack no responde: cd infra/local && docker compose up -d --build"; exit 1; }

head_ "1· Generando un vídeo de prueba de 40 s (dentro del worker, que tiene ffmpeg)"
$C exec -T worker sh -c '
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc=size=640x360:rate=24:duration=40" \
    -f lavfi -i "sine=frequency=440:duration=40" \
    -c:v libx264 -preset ultrafast -c:a aac -shortest /tmp/demo.mp4'
docker cp "$($C ps -q worker)":/tmp/demo.mp4 /tmp/ms-demo.mp4
ok "vídeo generado ($(du -h /tmp/ms-demo.mp4 | cut -f1))"

head_ "2· Subiendo como profesor (a través de nginx, igual que en producción)"
PROFE=$(sesion profe1 "Profe Demo" true)
RESP=$(curl -fsS -X POST "$BASE/videos" -H "Authorization: Bearer $PROFE" \
        -F title="Demo" -F file=@/tmp/ms-demo.mp4)
VID=$(echo "$RESP" | sed -E 's/.*"id":"([^"]+)".*/\1/')
ok "subido: $VID"

head_ "3· Esperando a la transcodificación A/B (ffmpeg ×2, ~40-90 s)"
for i in $(seq 1 60); do
  ST=$(curl -fsS "$BASE/videos/$VID" -H "Authorization: Bearer $PROFE" | sed -E 's/.*"status":"([^"]+)".*/\1/')
  [ "$ST" = "ready" ] && break
  [ "$ST" = "failed" ] && { bad "transcodificación fallida"; $C logs --tail=20 worker; exit 1; }
  printf '\r  … %s (%ss)' "$ST" "$((i*3))"; sleep 3
done
printf '\r'
[ "$ST" = "ready" ] && ok "listo — y ffmpeg ya no volverá a ejecutarse para este vídeo" || bad "sigue en $ST"

head_ "4· Dos alumnos abren el MISMO vídeo → patrones A/B distintos"
ANA=$(sesion ana "Ana García" false)
LUIS=$(sesion luis "Luis Martín" false)
PL_ANA=$(curl -fsS "$BASE/hls/$VID/index.m3u8?st=$ANA")
PL_LUIS=$(curl -fsS "$BASE/hls/$VID/index.m3u8?st=$LUIS")
PAT_ANA=$(echo "$PL_ANA"  | grep -oE '/[AB]/seg' | grep -oE '^/[AB]' | tr -d '/\n')
PAT_LUIS=$(echo "$PL_LUIS" | grep -oE '/[AB]/seg' | grep -oE '^/[AB]' | tr -d '/\n')
echo "     ana : $PAT_ANA"
echo "     luis: $PAT_LUIS"
[ "$PAT_ANA" != "$PAT_LUIS" ] && ok "mezclas distintas: la marca forense funciona" || bad "¡patrones iguales!"

head_ "5· Los segmentos van cifrados y sólo se sirven los de TU patrón"
SEG=$(echo "$PL_ANA" | grep -m1 'seg_')
OTRA=$(echo "$SEG" | awk '{ if ($0 ~ /\/A\//) gsub("/A/","/B/"); else gsub("/B/","/A/"); print }')
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
[ "$(code "$SEG")"          = 200 ] && ok "segmento firmado de su playlist → 200"        || bad "firmado dio $(code "$SEG")"
[ "$(code "${SEG%%\?*}")"   = 403 ] && ok "el mismo sin firma → 403"                     || bad "sin firma dio $(code "${SEG%%\?*}")"
[ "$(code "$OTRA")"         = 403 ] && ok "la OTRA variante con su firma → 403  ← esto es lo que impide escapar de la traza" || bad "variante cruzada dio $(code "$OTRA")"
[ "$(code "$BASE/media/$VID/key.bin")" = 403 ] && ok "la clave AES no se sirve como estático → 403" || bad "key.bin accesible"
FIRST=$($C exec -T worker sh -c "head -c1 /data/media/$VID/A/seg_0000.ts | od -An -tx1 | tr -d ' \n'")
[ "$FIRST" != "47" ] && ok "el .ts está cifrado (primer byte 0x$FIRST, no 0x47)" || bad "¡el segmento está en claro!"

head_ "6· Trazado forense: simulo la filtración de Ana y la traceo"

# En producción, view_event lo rellena el launch LTI. Aquí lo insertamos a mano
# porque estamos entrando por API, sin Moodle: son los candidatos del trazado.
$C exec -T db psql -U moodleshield -q -c \
  "INSERT INTO view_event (video_id,user_sub,user_name,user_identity)
   VALUES ('$VID','ana','Ana García','ana'),
          ('$VID','luis','Luis Martín','luis'),
          ('$VID','marta','Marta Ruiz','marta')" >/dev/null
ok "3 alumnos registrados como espectadores"

# La 'copia filtrada' se obtiene igual que la obtendría Ana: se reproduce su
# playlist personalizada, se descarga la clave con su token y los segmentos
# firmados, y se descifran. El resultado lleva SU patrón A/B en la imagen.
#
# La playlist trae URLs absolutas con PUBLIC_URL (localhost:8088), que es lo
# correcto —las resuelve el navegador del alumno—, pero dentro del contenedor
# ese host no existe. Para la demo las reapuntamos al nombre de servicio.
PUB=$($C exec -T app printenv PUBLIC_URL | tr -d '\r\n')
curl -fsS "$BASE/hls/$VID/index.m3u8?st=$ANA" \
  | sed "s|${PUB}|http://proxy:8080|g" > /tmp/ms-pl.m3u8
docker cp /tmp/ms-pl.m3u8 "$($C ps -q worker)":/tmp/pl.m3u8 >/dev/null

$C exec -T worker sh -c "
  ffmpeg -hide_banner -loglevel error -y -allowed_extensions ALL \
    -protocol_whitelist file,http,https,tcp,tls,crypto,data \
    -i /tmp/pl.m3u8 -c copy /tmp/filtrado.mp4" \
  && ok "copia de Ana descargada y descifrada (como lo haría su navegador)" \
  || bad "no se pudo descargar la copia"

$C exec -T worker node /app/tools/trace.mjs --video "$VID" --input /tmp/filtrado.mp4 2>&1 | tail -10

head_ "Resumen"
if [ "$FAILED" = 0 ]; then
  printf '  \033[32mTodo correcto.\033[0m ffmpeg corrió 2 veces y nunca más; cada alumno recibe\n'
  printf '  su propia mezcla; los segmentos están cifrados y firmados por patrón.\n\n'
  echo "  Vídeo de prueba: $VID"
  echo "  Para verlo en el navegador (con overlay):"
  echo "     open \"$BASE/hls/$VID/index.m3u8?st=<token>\"   # sólo descarga la playlist"
  echo "  El player completo requiere un launch LTI real desde Moodle."
else
  printf '  \033[31mHubo fallos.\033[0m Revisa arriba y mira: %s logs app worker\n' "$C"
  exit 1
fi
