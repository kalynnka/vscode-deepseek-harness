# Changelog

## [0.0.2](https://github.com/kalynnka/vscode-deepseek-harness/compare/0.0.1...0.0.2) (2026-08-14)


### Features

* give the extension dsh's own marks instead of a codicon ([30a84dc](https://github.com/kalynnka/vscode-deepseek-harness/commit/30a84dc4107a8fe807a7471a02b2397306edbd46))
* **m0:** scaffold the extension and prove the proposed APIs are granted ([ec908c0](https://github.com/kalynnka/vscode-deepseek-harness/commit/ec908c0568dcba80694412a760581c43035b548b))
* **m1:** drive the user's dsh and list its sessions read-only ([7e9f2c2](https://github.com/kalynnka/vscode-deepseek-harness/commit/7e9f2c2914ec45443649a04457208dcf8b6f2857))
* **m2,m3:** stream live turns and answer the agent's questions inline ([c22a1b5](https://github.com/kalynnka/vscode-deepseek-harness/commit/c22a1b50246304bf146273e276b7c83b4e7a0c45))
* **m4:** cancel, fork, create, and model and reasoning-effort pickers ([718983f](https://github.com/kalynnka/vscode-deepseek-harness/commit/718983fbcc17136f63e288f729b180c010712be9))
* **m5:** package a VSIX and document install and the proposal opt-in ([66dd4c9](https://github.com/kalynnka/vscode-deepseek-harness/commit/66dd4c9990b43cc03bb84155996132ecaf6c28f9))


### Bug Fixes

* bind a dsh session when the chat opens, so the composer has its pickers ([2b3ef7b](https://github.com/kalynnka/vscode-deepseek-harness/commit/2b3ef7b1106f072f431250040aa4a625a696ad58))
* publish the composer's pickers from the controller, where the editor asks for them ([90539f5](https://github.com/kalynnka/vscode-deepseek-harness/commit/90539f50483afd827a4f689064cccdc9a2b5fb44))
* read the carousel's real answer fields so selections reach dsh ([c65032d](https://github.com/kalynnka/vscode-deepseek-harness/commit/c65032d506c988c5e33f13cc521f61ce1dfcff2b))
* render permissions as its own picker, since the editor's is walled off ([2d2b98a](https://github.com/kalynnka/vscode-deepseek-harness/commit/2d2b98a6ccf5ac974fb82ea1f0d01552cc24cdd5))
* send the composer's attachments to dsh, and put its permission presets in the picker ([025d1a7](https://github.com/kalynnka/vscode-deepseek-harness/commit/025d1a73994c502bde89e03b1ddcffd22dc59c9b))
* stop the dev host from reopening another extension's window ([4a9ff01](https://github.com/kalynnka/vscode-deepseek-harness/commit/4a9ff017070b260282ac188d970568d14434e1e1))
* stop the picker from looping the extension host to death ([c9562c4](https://github.com/kalynnka/vscode-deepseek-harness/commit/c9562c4e9ea3a8d982457531782a95714bd78477))
* the agent handler was a stub, so every request rendered an empty bubble ([a67aa16](https://github.com/kalynnka/vscode-deepseek-harness/commit/a67aa16992d8fc929f194495277d7f020fa4d802))
* the chat participant id must equal the chat session type ([fecd64f](https://github.com/kalynnka/vscode-deepseek-harness/commit/fecd64f61b735a4b801c56739727b94d0ecca49c))
* the session provider never registered, and the probe hid it ([dab931c](https://github.com/kalynnka/vscode-deepseek-harness/commit/dab931c6307c4b7afb85ad29fa17cf069368d62f))
* without canDelegate there was no command to start a session ([d291b8a](https://github.com/kalynnka/vscode-deepseek-harness/commit/d291b8a518966bdb218e80d5db96a36677e02719))


### Documentation

* answer the proposed-API gate and correct the plan from source ([91aa7c8](https://github.com/kalynnka/vscode-deepseek-harness/commit/91aa7c8c78cd492340bdd67c3be24f4f04665d17))
* record why a third-party session type gets no tab of its own ([ab3ea31](https://github.com/kalynnka/vscode-deepseek-harness/commit/ab3ea3147e0eb0a8c5e1793430391d7e5f26e131))
* show the chat panel and rewrite install around the VSIX ([470bdd5](https://github.com/kalynnka/vscode-deepseek-harness/commit/470bdd508a178700fa4a3bb7eff2f95c302c8d5a))
