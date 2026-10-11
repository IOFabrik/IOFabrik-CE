# Contributing to IOFabrik

Bug reports, documentation improvements, and focused code changes are welcome. Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search [existing issues](https://github.com/IOFabrik/IOFabrik-CE/issues) before opening a new one.
- For bugs, include your app version, operating system, steps to reproduce, and expected and actual results. Remove confidential information from examples and screenshots.
- Discuss larger changes in an issue before implementing them.
- Report security vulnerabilities privately using the [security policy](SECURITY.md).

## Licensing and contributor agreement

The public edition is licensed under [AGPL-3.0](License.md). IOFabrik's intended dual-licensing model also allows the project owner to offer separate commercial licenses where it holds the necessary rights.

To support this model, contributions will require a contributor license agreement (CLA) before they can be accepted. Contributors retain copyright; the intended CLA grants the project owner permission to use, modify, distribute, sublicense, and relicense contributions under other terms, **including proprietary and commercial licenses**. Contributions included in the public edition remain available under AGPL-3.0.

The [draft CLA](CLA.md) names IOFabrik as the recipient and uses the laws of the Netherlands. **It is awaiting legal review and is not open for signature.** Maintainers must publish the approved agreement and signing process, then obtain the required contributor consent before merging external contributions covered by it. Opening a change request does not by itself grant additional commercial relicensing rights.

For licensing or employer-authorization questions, contact [hello@iofabrik.com](mailto:hello@iofabrik.com). Do not post signed agreements or personal information in public issues.

Only submit work you have authority to contribute. Obtain employer permission where needed, and identify third-party code, its source, and its license. A CLA cannot grant rights you do not hold.

## Set up and test

Follow the [development setup](docs/onboarding/Development%20Setup.md). Frontend installs fetch the immutable `ladder-visualizer` revision pinned in the package files; a sibling checkout is optional for library development.

For code changes, run these checks from the repository root:

```bash
go build ./...
go test . ./services/...
npm --prefix frontend run ci:guards
npm --prefix frontend test
npm --prefix frontend run build
python3 scripts/check-publication.py
```

For documentation-only changes, check links, run `git diff --check`, and run the publication check. Application builds are not needed unless the change affects code or build instructions.

## Submit your changes

1. Create a focused change based on `main` in your fork or a separate development branch.
2. Follow the [development workflow](docs/processes/Development%20Workflow.md). Add tests and update documentation where relevant.
3. Open a pull request against `main`. Explain what changed, why, and how you tested it. Include screenshots for interface changes and disclose any checks you could not run.
4. Address review feedback and complete the CLA process once it is available. Maintainers will review licensing and technical readiness before merging.

Do not include credentials, customer project files, generated build output, or unrelated changes. If you change an exported Go service interface, regenerate bindings with `task common:generate:bindings`; do not edit generated bindings by hand.
