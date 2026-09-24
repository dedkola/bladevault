#!/usr/bin/env bash

set -euo pipefail

image_ref="${1:?usage: container-smoke.sh <image-ref>}"
container_name="bladevault-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
volume_name="${container_name}-data"
base_url=''

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
}

show_logs() {
  echo 'BladeVault container logs:'
  docker logs "$container_name" 2>&1 || true
}

trap cleanup EXIT
trap show_logs ERR

docker volume create "$volume_name" >/dev/null

start_container() {
  docker run --detach \
    --name "$container_name" \
    --publish 127.0.0.1::3000 \
    --volume "$volume_name:/app/data" \
    "$image_ref" >/dev/null

  local host_port
  host_port="$(docker port "$container_name" 3000/tcp | awk -F: 'NR == 1 { print $NF }')"
  test -n "$host_port"
  base_url="http://127.0.0.1:${host_port}"

  for attempt in {1..60}; do
    if curl --fail --silent --show-error "$base_url/api/knives" >/dev/null; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != 'true' ]]; then
      return 1
    fi
    sleep 2
  done

  echo 'Timed out waiting for BladeVault to become ready.' >&2
  return 1
}

start_container

initial_payload="$(curl --fail --silent --show-error "$base_url/api/knives")"
node -e "const payload = JSON.parse(process.argv[1]); if (!Array.isArray(payload.knives) || payload.knives.length !== 0) process.exit(1)" "$initial_payload"

created_payload="$(curl --fail --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"name":"Container Persistence Smoke","brand":"BladeVault"}' \
  "$base_url/api/knives")"
created_id="$(node -e "const payload = JSON.parse(process.argv[1]); if (!payload.knife?.id) process.exit(1); process.stdout.write(payload.knife.id)" "$created_payload")"

comparison_request="$(node -e "process.stdout.write(JSON.stringify({action:'create',name:'Container comparison',ids:[process.argv[1]]}))" "$created_id")"
comparison_payload="$(curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data "$comparison_request" "$base_url/api/comparisons")"
comparison_id="$(node -e "const payload=JSON.parse(process.argv[1]); if(!payload.listId) process.exit(1); process.stdout.write(payload.listId)" "$comparison_payload")"

docker rm -f "$container_name" >/dev/null
start_container

persisted_payload="$(curl --fail --silent --show-error "$base_url/api/knives")"
node -e "const payload = JSON.parse(process.argv[1]); if (!payload.knives?.some((knife) => knife.id === process.argv[2])) process.exit(1)" "$persisted_payload" "$created_id"

persisted_comparisons="$(curl --fail --silent --show-error "$base_url/api/comparisons")"
node -e "const payload=JSON.parse(process.argv[1]); const list=payload.lists?.find(list=>list.id===process.argv[2]); if(list?.name!=='Container comparison'||list.ids.length!==1||list.ids[0]!==process.argv[3]) process.exit(1)" "$persisted_comparisons" "$comparison_id" "$created_id"

curl --fail --silent --show-error "$base_url/" >/dev/null
echo 'Container smoke passed: startup, API, static app, and named comparison SQLite persistence after restart.'
