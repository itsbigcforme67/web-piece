# Other people's code used by web-piece

| Folder | What | Version | Licence |
|---|---|---|---|
| `piece-emu/` | The P/ECE emulator core by Autch.net: S1C33209 CPU, on-chip peripherals, LCD controller, flash. | [autch/piece-emu](https://github.com/autch/piece-emu) @ `08ec4b45176e` | MIT (`piece-emu/LICENSE`) |
| `lhasa/` | LHA archive reader by Simon Howard. | [fragglet/lhasa](https://github.com/fragglet/lhasa) @ `75ed83559f23` | ISC (`lhasa/COPYING.md`) |

Both are copied unchanged by `tools/vendor.sh`, with one exception: in piece-emu, `throw std::…(` is replaced by
`piece_fatal(` (declared in the added `piece-emu/piece_fatal.hpp`) because the WebAssembly build has no C++ exceptions.
