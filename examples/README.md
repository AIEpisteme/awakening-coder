# Examples

Things built with awakening-coder, kept here as worked examples. Each one runs on its own and has its own tests.

| Example | What it is | Run it |
|---|---|---|
| [`tinykv/`](tinykv/) | A tiny JSON-file key-value store with a CLI. No dependencies, writes atomically, and is safe under concurrent writers. | `cd examples/tinykv && node bin/tinykv.js --help` · tests: `node --test` |
| [`snake/`](snake/) | A browser Snake game with its game logic separated out and tested. | open `examples/snake/index.html` · tests: `node --test examples/snake/logic.test.js` |
| [`hello-claude.js`](hello-claude.js) | The smallest possible Claude API call with the SDK, useful for checking that your key works. | `node examples/hello-claude.js` (needs `ANTHROPIC_API_KEY`) |
| [`AWAKEN.example.md`](AWAKEN.example.md) | Sample output of `/init`: the project notes it writes about a codebase and reads at the start of each session. | — |

Running `npm test` from the repository root also runs the examples' tests.
