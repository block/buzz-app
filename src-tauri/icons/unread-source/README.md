# Desktop unread artwork

The tray uses Phosphor `ChatsCircle` Bold from the pinned
`@phosphor-icons/core/assets/bold/chats-circle-bold.svg` (MIT; see that package's
LICENSE). The surrounding circles are simple unread/state decoration.

The SVG sources render at 32×32. The adjacent PNGs are rasterized from these SVGs
using Chromium's canvas `drawImage` and `toDataURL("image/png")`, with no scaling.
Tauri's `include_image!` embeds the pixels at compile time: no runtime image loader,
filesystem lookup, or image-decoding Cargo feature is needed.

Normal tray: 28px dark backing, 20px yellow chat glyph. Unread tray: adds an 8px
purple dot with a 1px white outline. Windows overlay: 28px white circle enclosing
a 20px purple dot. The added shape, not color alone, distinguishes unread.

## Phosphor license

MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
