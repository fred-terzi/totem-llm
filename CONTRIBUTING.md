# Contributing to Totem LLM

Totem LLM is an open-source, self-hosted AI assistant. We welcome contributions from the community.

## Reporting Issues

If you find a bug or have a feature request, please open an issue on the
[GitHub issue tracker](https://github.com/fred-terzi/totem-llm/issues).

## Picking an Issue

We track issues on GitHub. If you're looking for something to work on, check the
[good first issues](https://github.com/fred-terzi/totem-llm/labels/good%20first%20issue).
These are typically well-described and have a small scope.

Before starting work on an issue, **leave a comment** to claim it. This helps avoid
duplicate effort and gives us a chance to provide guidance or clarify scope.

## Before You Start

We are a small team with limited bandwidth. We do our best to review and merge
pull requests promptly, but please be patient. Keep in mind:

- **An issue is required.** PRs without a corresponding issue will not be merged
  (the only exception is language translations).
- We become the maintainers of your changes. We are responsible for ensuring they
  work correctly and remain compatible with the rest of the project.
- Merging is at our discretion. We value quality and the overall user experience.
  A "no" is not a reflection on the quality of your work.
- **Security:** If you discover a vulnerability, please do **not** open a public
  issue. Email us directly at [terzitech@gmail.com](mailto:terzitech@gmail.com).

## Setting Up Your Development Environment

Fork the repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<username>/totem-llm.git
cd totem-llm
```

Add the upstream remote:

```bash
git remote add upstream https://github.com/fred-terzi/totem-llm.git
git fetch upstream
```

Install dependencies and set up the environment:

```bash
yarn setup
```

This installs all sub-project dependencies, creates the expected `.env` files,
and runs the Prisma setup script.

Start the development servers:

```bash
yarn dev:all
```

This launches the server, frontend, and collector in development mode with hot
reloading.

## Pull Request Guidelines

For the best chance of having your PR accepted:

1. **Test your changes.** All bug fixes and new features must include tests.
2. **Keep PRs focused.** Solve one problem at a time when possible.
3. **Use conventional commit messages** as PR titles:
   - New feature: `feat: add …`
   - Bug fix: `fix: …`
   - Documentation: `docs: …`
4. **Self-review** before marking your PR ready. Make sure the intent of your
   changes is clear.
5. **Leave WIP PRs as drafts.** We assume a PR is ready for review once it is
   opened (not in draft).

## Project Structure

```
totem-llm/
├── server/       # Node.js backend (Express + Prisma)
├── frontend/     # React frontend
├── collector/    # Python document collector
├── embed/        # Embeddable widget
└── browser-extension/  # Browser extension
```

## Release Process

Changes are released from the `main-totem` branch. When a PR is merged, a new
Docker image is built and published to Docker Hub and the GitHub Container
Registry under both a version tag (`v<major>.<minor>.<patch>`) and the `latest`
tag.

## License

By contributing to Totem LLM, you agree to license your contributions under the
[MIT License](./LICENSE).
