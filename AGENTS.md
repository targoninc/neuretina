# AGENTS.md

- Always make generic and modular approaches.
- Always check whether something can be solved more elegantly with less code.
- Deduplicate: if you see something solved similarly twice, unify components and logic wherever possible.
- Run tests with `bun run test`; `--isolate` keeps files from sharing `globalThis.fetch` mocks.
- After finishing a feature, commit and push the changes unless told otherwise.
