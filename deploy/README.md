# Holy Songs Nomad Deploy

This deploys the single production image from `Dockerfile`. The container serves
both the frontend and backend on port `8000`, which is what the Nomad job exposes
behind Traefik for `holy-songs.bcgen.ie`.

GitHub Actions publishes the image, joins the Headscale tailnet, and deploys it
directly to Nomad with a Nomad token. The workflow uses the same Nomad API
address as Accounta: `http://100.64.0.5:4646`.

Required GitHub Actions secrets:

- `NOMAD_TOKEN`: Nomad token with permission to plan/run the `holy-songs` job
- `HEADSCALE_AUTHKEY`: Headscale/Tailscale auth key for joining the tailnet

The workflow preserves the currently registered Nomad job, updates the
`holy-songs` task image, and keeps the content repo GitHub token out of GitHub
Actions. The running task reads `GITHUB_TOKEN` from OpenBao at
`kv/data/services/holy-songs/shared`, with sops+age as the source of truth in
`private-cloud-federation/platform/compose/secrets/services/holy-songs/shared.enc.env`.

The live-band WebRTC endpoint relies on the registered
`private-cloud-federation` job's oauth2-proxy sidecar and authenticated
`/api/live` Traefik route. The standalone template in this repository does not
provision PocketID and is therefore insufficient for the production live-band
endpoint by itself. See [`docs/live-band.md`](../docs/live-band.md).

Run from the repo root:

```bash
export NOMAD_ADDR="https://your-nomad.example.com"
export GHCR_TOKEN="..." # token with write:packages, or use an existing docker login
export HOLY_SONGS_ADMIN_TOKEN="..."
export CONTENT_REPO_HOST_PATH="/srv/holy-songs-content"

npm run deploy:nomad
```

The script builds and pushes:

- `ghcr.io/loyyd/holy-songs:<git-sha>`
- `ghcr.io/loyyd/holy-songs:latest`

Nomad deploys the immutable SHA tag by default. To force the job to reference the
literal `latest` tag instead:

```bash
DEPLOY_REF="ghcr.io/loyyd/holy-songs:latest" npm run deploy:nomad
```

Useful overrides:

- `NOMAD_DATACENTERS`: defaults to `dc1`
- `HOLY_SONGS_DOMAIN`: defaults to `holy-songs.bcgen.ie`
- `TRAEFIK_ENTRYPOINT`: defaults to `websecure`
- `TRAEFIK_CERT_RESOLVER`: defaults to `letsencrypt`
- `PLATFORMS`: defaults to `linux/amd64`
- `BUILD_ONLY=1`: build and push images without running Nomad
- `SKIP_TESTS=1`: skip local test checks
- `SKIP_GHCR_LOGIN=1`: assume Docker is already logged in to GHCR

## Content repo token rotation

If the content repo PAT is exposed, revoke the leaked token in GitHub, create a
new fine-grained token for the content repository with the minimum contents
permissions the app needs, update `GITHUB_TOKEN` in the sops file above, and
publish the sops tree into OpenBao with:

```bash
cd ../private-cloud-federation
BAO_TOKEN="..." SOPS_AGE_KEY_FILE="..." deploy/openbao/scripts/import_sops_tree.sh
```

After the OpenBao write, redeploy or restart `holy-songs` so Nomad re-renders the
`secrets/github-token.env` template for the app task.
