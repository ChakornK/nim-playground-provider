# Contributing

`nim-playground-provider` is a small project. Keep changes focused.

## Prerequisites

- Node.js 22+
- For live tests or local runs: [Lightpanda](https://github.com/lightpanda-io/browser) on your `PATH` (or set `LIGHTPANDA_PATH`)

## Setup

```bash
git clone https://github.com/ChakornK/nim-playground-provider.git
cd nim-playground-provider
npm install
```

## Making changes

Before opening a PR, run the full check:

```bash
npm run check
```

Individual tools:

```bash
npm run format
npm run lint
npm run typecheck
```

## Tests

```bash
# unit + offline integration
npm test
# live smoke tests
NVIDIA_LIVE=1 npm test
```

Live tests need a working Lightpanda install and network access to `build.nvidia.com`. Skip them unless your change touches token minting or the NVIDIA API path.

## Coding style

- Biome (lint) and Prettier (format) define the style. `npm run check` enforces it.
- No new dependencies unless the task is impossible with what's in `package.json`.
- Keep diffs minimal. Don't reformat unrelated code. Commit messages can be prose.

## Commits and pull requests

- Try to keep one logical change per PR.
- Try to follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). However, not following it will not prevent your PR from being merged.
- Describe what changed and why. If the PR fixes an existing issue, reference it: `Fixes #67`.

## Reporting issues

Open a GitHub issue with what you expected, what happened, and steps to reproduce.

## License

By contributing you agree your changes are licensed under the project's [MIT License](./LICENSE).
