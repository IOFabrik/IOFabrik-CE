# Documentation Standards

> How we write and maintain IOFabrik documentation.

## Structure

Public documentation lives in `docs/` with this structure:

```
docs/
  HOME.md                          → Main index (start here)
  product/                         → Non-technical product docs
  technical/
    architecture/                  → System design & patterns
    backend/                       → Go backend docs
      services/                    → Individual service docs
    frontend/                      → React frontend docs
      features/                    → Feature-specific docs
    infrastructure/                → CLI runner, data paths, logging
    guides/                        → How-to guides
    reference/                     → Constants, events, env vars
  onboarding/                      → New engineer docs
  processes/                       → Public contribution workflow
```

## Writing Guidelines

### Audience

- **Product docs** (`product/`): Written for anyone. No code, no Git jargon.
- **Technical docs** (`technical/`, `onboarding/`, `processes/`): Written for engineers. Code is expected, but explain *why*, not just *what*.

### Format

Every documentation page should include:

1. **Title** — `# Page Name` (matches the filename)
2. **Summary** — One-line blockquote below the title: `> What this page covers`
3. **Body** — Content organized with `##` and `###` headings
4. **Related links** — At the bottom: `**Related:** [Page title](relative-path.md)`

### Cross-Linking

Use relative Markdown links so documentation works on GitHub and in local editors.
Encode spaces in link targets as `%20`. Link only to public files that exist and
prefer a page link when a stable section anchor is unavailable.

### Code Blocks

Always specify the language:

````markdown
```go
func (g *GitService) CommitAll(repoPath, message string) OperationResult {
```

```tsx
const { status } = useRepo();
```

```bash
task dev
```
````

### Tables

Use tables for reference data, parameter lists, and comparisons:

```markdown
| Parameter | Type | Description |
|---|---|---|
| `repoPath` | `string` | Absolute path to the repository |
| `message` | `string` | Commit message |
```

## When to Update Docs

| Change | Documentation Action |
|---|---|
| New Go service | Add to [Services Index](../technical/backend/Services%20Index.md), create service page in `backend/services/` |
| New service method | Update the relevant service doc |
| New frontend view | Update [Layout System](../technical/frontend/Layout%20System.md), create feature doc if substantial |
| New viewer | Update [Viewer System](../technical/frontend/Viewer%20System.md), follow [Adding a New Viewer](../technical/guides/Adding%20a%20New%20Viewer.md) |
| New event | Update [Event Reference](../technical/reference/Event%20Reference.md) and [Event System](../technical/architecture/Event%20System.md) |
| New constant | Update [Constants Reference](../technical/reference/Constants%20Reference.md) |
| Changed env var | Update [Environment Variables](../technical/reference/Environment%20Variables.md) |
| New build step | Update [Build and Release](../technical/guides/Build%20and%20Release.md) and [Development Setup](../onboarding/Development%20Setup.md) |
| Architecture decision | Update relevant architecture doc |

## File Naming

- Use **Title Case with spaces**: `Adding a New Service.md`, not `adding-a-new-service.md`
- Encode spaces in Markdown link targets
- Keep names concise but descriptive

## Maintenance

- Review docs quarterly for accuracy
- After major refactors, audit affected pages
- Keep working plans, internal reviews, incident reports, and release operations in private storage outside this repository.
- Preserve superseded internal material privately; maintain current public guides here.

---

**Related:** [HOME](../HOME.md) | [Onboarding Guide](../onboarding/Onboarding%20Guide.md) | [Development Workflow](Development%20Workflow.md)
