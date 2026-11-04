# Assets

`banner.png` is the README hero, rendered from `banner.html` at twice its CSS size so it stays
sharp on high-density screens:

```console
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,400 \
  --screenshot=docs/assets/banner.png \
  "file://$PWD/docs/assets/banner.html"
```

`banner.zh-CN.png` is the same banner in Chinese, rendered the same way from
`banner.zh-CN.html`. Both share their palette and type with [the social preview](../social-preview/README.md).

`demo.png` is the terminal demo near the top of the README, rendered from `demo.html` with a
transparent background so it sits well on light and dark GitHub themes:

```console
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --default-background-color=00000000 --window-size=1100,590 \
  --screenshot=docs/assets/demo.png \
  "file://$PWD/docs/assets/demo.html"
```
