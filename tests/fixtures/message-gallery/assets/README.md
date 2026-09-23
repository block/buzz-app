# Local sample clip

`sample.mp4` is a two-second synthetic test pattern generated locally with:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=640x360:rate=12' -t 2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an sample.mp4
```

It contains no user media or audio. The gallery resolves sample attachment URLs
locally; no relay media request is made.
