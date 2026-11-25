# Local sample clips

`sample.mp4` is a two-second synthetic test pattern generated locally with:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=640x360:rate=12' -t 2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an sample.mp4
```

`sample-long.mp4` is a one-minute clip for journeys that must not reach a
video's end, generated locally with:

```sh
ffmpeg -f lavfi -i 'testsrc=size=160x90:rate=12' -t 60 -c:v libx264 -preset veryslow -crf 42 -g 24 -pix_fmt yuv420p -movflags +faststart -an sample-long.mp4
```

They contain no user media or audio. The gallery resolves sample attachment URLs
locally; no relay media request is made.
