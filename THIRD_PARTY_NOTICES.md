# Third-party notices

EaW Localisation Hub is licensed under GPL-2.0-only. It uses or redistributes the following third-party components under their respective licenses.

| Component | Purpose | License | Source |
| --- | --- | --- | --- |
| Notepad++ Plugin Template / SDK headers | Native Legacy plugin integration | GPL-2.0 | `vendor/npp-plugin-template` |
| nlohmann/json | Native JSON handling | MIT | `vendor/nlohmann-json` |
| Node.js | Bundled JavaScript runtime | MIT and bundled third-party notices | <https://nodejs.org/> |
| Monaco Editor | Review editor | MIT | <https://github.com/microsoft/monaco-editor> |
| Yjs, lib0, isomorphic.js | Collaborative document model | MIT | package metadata in `node_modules` / `package-lock.json` |
| ws | WebSocket transport | MIT | <https://github.com/websockets/ws> |
| ssh2 and its dependencies | Deployer SSH/SFTP transport | MIT-compatible licenses recorded in package metadata | <https://github.com/mscdex/ssh2> |
| esbuild | Review web bundling | MIT | <https://github.com/evanw/esbuild> |
| Caddy | Optional TLS reverse proxy Docker image | Apache-2.0 | <https://github.com/caddyserver/caddy> |

The distributable packages retain dependency license files. The bundled Node.js runtime is accompanied by the complete `LICENSE` file from the exact Node.js distribution used for the build. `package-lock.json` records exact JavaScript dependency versions.

Microsoft WebView2 Runtime, Notepad++ itself, GitHub Desktop, Git for Windows, Docker and Inno Setup are external prerequisites or build tools and are not relicensed by this project.
