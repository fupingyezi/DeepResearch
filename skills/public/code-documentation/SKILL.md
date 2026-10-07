---
name: code-documentation
description: Use this skill when the user requests to generate, create, or improve documentation for code, APIs, libraries, repositories, or software projects (e.g., 写文档、生成 README、写 API 文档、补注释、写架构文档、生成 changelog、写开发者指南、document this code). Supports README generation, API reference documentation, inline code comments, architecture documentation, changelog generation, and developer guides — always produced from actual code analysis, never guessed signatures.
---

# Code Documentation Skill

## Overview

This skill generates professional, comprehensive documentation for software projects, codebases, libraries, and APIs. It follows industry best practices from projects like React, Django, Stripe, and Kubernetes to produce documentation that is accurate, well-structured, and useful for both new contributors and experienced developers.

The output ranges from single-file READMEs to multi-document developer guides, always matched to the project's complexity and the user's needs.

## Core Capabilities

- Generate comprehensive README.md files with badges, installation, usage, and API reference
- Create API reference documentation from source code analysis
- Produce architecture and design documentation with diagrams
- Write developer onboarding and contribution guides
- Generate changelogs from commit history or release notes
- Create inline code documentation following language-specific conventions
- Support JSDoc, docstrings, GoDoc, Javadoc, and Rustdoc formats
- Adapt documentation style to the project's language and ecosystem

## When to Use This Skill

**Always load this skill when:**

- User asks to "document", "create docs", or "write documentation" for any code
- User requests a README, API reference, or developer guide
- User shares a codebase or repository and wants documentation generated
- User asks to improve or update existing documentation
- User needs architecture documentation, including diagrams
- User requests a changelog or migration guide

## Workflow Summary (Three Phases)

1. **Phase 1 — Codebase Analysis**: Discover language/framework/build system, explore structure with sandbox tools, determine documentation scope. Read `references/phase1-codebase-analysis.md` before analyzing.
2. **Phase 2 — Documentation Generation**: Produce README / API reference / architecture docs / inline comments. Read `references/phase2-documentation-generation.md` for all templates and per-language conventions.
3. **Phase 3 — QA & Style**: Completeness check, quality standards, cross-reference validation, writing principles. Read `references/phase3-qa-and-style.md` before finalizing.

## Output Handling

After generation:

- Save documentation files to `/mnt/user-data/outputs/`
- For multi-file documentation, maintain the project directory structure
- Present generated files to the user using the `present_files` tool
- Offer to iterate on specific sections or adjust the level of detail
- Suggest additional documentation that might be valuable

## Notes

- Always analyze the actual code before writing documentation — never guess at API signatures or behavior
- When existing documentation exists, preserve its structure unless the user explicitly asks for a rewrite
- For large codebases, prioritize documenting the public API surface and key abstractions first
- Documentation should be written in the same language as the project's existing docs; default to English if none exist
- When generating changelogs, use the [Keep a Changelog](https://keepachangelog.com/) format
- This skill works well in combination with the `deep-research` skill for documenting third-party integrations or dependencies
