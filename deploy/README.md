# GateX static deployment preparation

This package is prepared for direct static serving at `gatex.ajkadri.dev` on `2.29.11.26`. It is documentation only for Gate G1. Do not execute it until the release is explicitly authorized.

## Release upload

Replace `<revision>` with the exact release commit and run from the repository root:

```sh
ssh admin@2.29.11.26 "install -d -m 755 /var/www/gatex/releases/<revision> /var/www/gatex/shared/assets"
rsync -az --delete dist/ admin@2.29.11.26:/var/www/gatex/releases/<revision>/
```

Then verify the uploaded release without changing the active symlink:

```sh
ssh admin@2.29.11.26 "find /var/www/gatex/releases/<revision> -type f -maxdepth 3 -print; test -r /var/www/gatex/releases/<revision>/index.html; test -r /var/www/gatex/releases/<revision>/evidence/release.json; stat -c '%U:%G %a %n' /var/www/gatex/releases/<revision>/index.html"
ssh admin@2.29.11.26 "df -h /var/www"
```

## Caddy validation and activation

Copy `deploy/Caddyfile.gatex` into the existing Caddy configuration only after reviewing the complete current file and preserving unrelated site blocks. Validate before any reload:

```sh
ssh admin@2.29.11.26 "caddy validate --config /etc/caddy/Caddyfile"
```

Switch the static release atomically after validation. The old symlink target is the rollback reference:

```sh
ssh admin@2.29.11.26 "readlink -f /var/www/gatex/current; ln -sfn /var/www/gatex/releases/<revision> /var/www/gatex/current.next; mv -Tf /var/www/gatex/current.next /var/www/gatex/current"
```

Reload Caddy only when the Caddy configuration changed, and only after `caddy validate` succeeds. A static release switch alone does not require a reload:

```sh
ssh admin@2.29.11.26 "sudo systemctl reload caddy"
```

## Smoke test and rollback

```sh
curl --fail --silent --show-error --head https://gatex.ajkadri.dev/
curl --fail --silent --show-error https://gatex.ajkadri.dev/evidence/release.json
```

Confirm the existing applications and their site blocks remain reachable before declaring the release active. To roll back, replace `<previous-revision>` with the target from the pre-switch `readlink` result and switch the symlink using the same `.next` plus `mv -Tf` sequence. Do not delete releases during this checkpoint.
