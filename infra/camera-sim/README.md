# Simulated cameras

Two fake farm cameras for development. A looping sheep video is served over RTSP, the same protocol as
the IP cameras in spec 16, and the helper acts as the farm's edge device through the real device API.
It proves the connection, live view, device status, and the path from a detection to alerts and
Telegram. It proves nothing about detection accuracy in a real barn.

## First run

Needs the demo data and a running API.

```sh
mkdir -p infra/camera-sim/videos infra/camera-sim/snapshots
curl -L -A "YAP-dev-sim/1.0" -o infra/camera-sim/videos/sheep.webm \
  "https://commons.wikimedia.org/wiki/Special:FilePath/Sheep.webm"
pnpm camera:up       # start the streams
pnpm camera:setup    # connect them to the first two barn cameras, once per database
pnpm camera:run      # keep running: heartbeats and snapshot server
```

Then open **Cameras → Live view**. `pnpm camera:down` stops the streams.

## Sending a detection

```sh
pnpm camera:event trough_empty attention
pnpm camera:event smoke urgent       # raises an alert and reaches Telegram, repeating until acknowledged
```

## Addresses

| What | Address |
| --- | --- |
| RTSP, as a real camera or Frigate would use it | `rtsp://localhost:8554/barn-1`, `barn-2` |
| Browser page, stored as the camera's Live URL | `http://localhost:8889/barn-1` |
| MediaMTX API | `http://127.0.0.1:9997/v3/paths/list` |

Browsers cannot play RTSP, so MediaMTX also acts as the gateway. Production must serve the gateway over
HTTPS, because the content security policy in `infra/nginx-security-headers.inc` allows only that.

## Video credit

`Sheep.webm` from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sheep.webm), CC BY-SA 4.0.
It is downloaded locally and is not part of this repository.
