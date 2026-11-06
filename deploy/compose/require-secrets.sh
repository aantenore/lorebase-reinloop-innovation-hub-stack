#!/bin/sh
# Copy of deploy/compose/require-secrets.sh at lorebase v0.3.1 (scripts/lorebase-up.sh sync): do not edit; change LOREBASE_VERSION and run sync.
# One-shot guard of an optional profile: exits 1, naming the variable, unless every secret named
# in the arguments is set to a real value. Compose interpolation cannot require a variable only
# when a profile is enabled (`${VAR:?}` fails for every profile), so the services that need a
# secret depend on this check instead and never start with an empty or placeholder value.
#
# Usage: require-secrets.sh NAME...   (each NAME is an environment variable of the container)
# Environment: the named variables; SECRET_MIN_LENGTH (default 16).
set -eu
min="${SECRET_MIN_LENGTH:-16}"
status=0
for name in "$@"; do
  case "$name" in
    "" | [0-9]* | *[!A-Za-z0-9_]*) echo "not a variable name: $name" >&2; exit 2 ;;
  esac
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name is empty: set it in the environment file (see .env.example)" >&2
    status=1
  elif [ "$value" = "change-me" ]; then
    echo "$name still has the placeholder value change-me: generate one (see .env.example)" >&2
    status=1
  elif [ "${#value}" -lt "$min" ]; then
    echo "$name is shorter than $min characters: generate one (see .env.example)" >&2
    status=1
  fi
done
exit "$status"
