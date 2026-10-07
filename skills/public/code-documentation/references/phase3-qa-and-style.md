# Phase 3: Quality Assurance & Style Guide

## Step 3.1: Documentation Completeness Check

Verify the documentation covers:

- [ ] **What it is** — Clear project description that a newcomer can understand
- [ ] **Why it exists** — Problem it solves and value proposition
- [ ] **How to install** — Copy-paste-ready installation commands
- [ ] **How to use** — At least one minimal working example
- [ ] **API surface** — All public functions, classes, and types documented
- [ ] **Configuration** — All environment variables, config files, and options
- [ ] **Error handling** — Common errors and how to resolve them
- [ ] **Contributing** — How to set up dev environment and submit changes

## Step 3.2: Quality Standards

| Standard          | Check                                                        |
| ----------------- | ------------------------------------------------------------ |
| **Accuracy**      | Every code example must actually work with the described API |
| **Completeness**  | No public API surface left undocumented                      |
| **Consistency**   | Same formatting and structure throughout                     |
| **Freshness**     | Documentation matches the current code, not an older version |
| **Accessibility** | No jargon without explanation, acronyms defined on first use |
| **Examples**      | Every complex concept has at least one practical example     |

## Step 3.3: Cross-reference Validation

Ensure:

- All mentioned file paths exist in the project
- All referenced functions and classes exist in the code
- All code examples use the correct function signatures
- Version numbers match the project's actual version
- All links (internal and external) are valid

## Writing Principles

1. **Lead with the "why"** — Before explaining how something works, explain why it exists
2. **Progressive disclosure** — Start simple, add complexity gradually
3. **Show, don't tell** — Prefer code examples over lengthy explanations
4. **Active voice** — "The function returns X" not "X is returned by the function"
5. **Present tense** — "The server starts on port 8080" not "The server will start on port 8080"
6. **Second person** — "You can configure..." not "Users can configure..."

## Formatting Rules

- Use ATX-style headers (`#`, `##`, `###`)
- Use fenced code blocks with language specification (` ```python `, ` ```bash `)
- Use tables for structured information (parameters, options, configuration)
- Use admonitions for important notes, warnings, and tips
- Keep line length readable (wrap prose at ~80-100 characters in source)
- Use `code formatting` for function names, file paths, variable names, and CLI commands

## Language-Specific Conventions

| Language              | Doc Format              | Style Guide          |
| --------------------- | ----------------------- | -------------------- |
| Python                | Google-style docstrings | PEP 257              |
| TypeScript/JavaScript | TSDoc / JSDoc           | TypeDoc conventions  |
| Go                    | GoDoc comments          | Effective Go         |
| Rust                  | Rustdoc (`///`)         | Rust API Guidelines  |
| Java                  | Javadoc                 | Oracle Javadoc Guide |
| C/C++                 | Doxygen                 | Doxygen manual       |
