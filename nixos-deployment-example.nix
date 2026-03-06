{ config, pkgs, ... }:

{
  # Ensure that Docker or Podman is enabled on your NixOS server
  # virtualisation.docker.enable = true;
  # virtualisation.oci-containers.backend = "docker"; # or "podman"

  virtualisation.oci-containers.containers."chord-songs" = {
    # Replace this with the actual image name/tag.
    # If building locally on the server, ensure the image is built and available.
    # Alternatively, you can pull it from a container registry (e.g., ghcr.io/your-username/chord-songs:latest).
    image = "chord-songs:latest";

    # Map port 8000 on the host to port 8000 in the container
    ports = [
      "8000:8000"
    ];

    # Map the host directories to the container directories.
    # IMPORTANT: Replace the host paths (the part before the colon) with the
    # actual absolute paths to the songs and backend directories on the NixOS server.
    volumes = [
      "/absolute/path/to/host/songs:/app/songs"
      "/absolute/path/to/host/backend:/app/backend"
    ];

    # Automatically start the container when the system boots
    # (equivalent to 'restart: unless-stopped' in docker-compose)
    autoStart = true;
  };
}
