# Phase 1: Codebase Analysis

Before writing any documentation, thoroughly understand the codebase.

## Step 1.1: Project Discovery

Identify the project fundamentals:

| Field                 | How to Determine                                                                      |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Language(s)**       | Check file extensions, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc. |
| **Framework**         | Look at dependencies for known frameworks (React, Django, Express, Spring, etc.)      |
| **Build System**      | Check for `Makefile`, `CMakeLists.txt`, `webpack.config.js`, `build.gradle`, etc.     |
| **Package Manager**   | npm/yarn/pnpm, pip/uv/poetry, cargo, go modules, etc.                                 |
| **Project Structure** | Map out the directory tree to understand the architecture                             |
| **Entry Points**      | Find main files, CLI entry points, exported modules                                   |
| **Existing Docs**     | Check for existing README, docs/, wiki, or inline documentation                       |

## Step 1.2: Code Structure Analysis

Use sandbox tools to explore the codebase:

```bash
# Get directory structure
ls /mnt/user-data/uploads/project-dir/

# Read key files
read_file /mnt/user-data/uploads/project-dir/package.json
read_file /mnt/user-data/uploads/project-dir/pyproject.toml

# Search for public API surfaces
grep -r "export " /mnt/user-data/uploads/project-dir/src/
grep -r "def " /mnt/user-data/uploads/project-dir/src/ --include="*.py"
grep -r "func " /mnt/user-data/uploads/project-dir/ --include="*.go"
```

## Step 1.3: Identify Documentation Scope

Based on analysis, determine what documentation to produce:

| Project Size             | Recommended Documentation                              |
| ------------------------ | ------------------------------------------------------ |
| **Single file / script** | Inline comments + usage header                         |
| **Small library**        | README with API reference                              |
| **Medium project**       | README + API docs + examples                           |
| **Large project**        | README + Architecture + API + Contributing + Changelog |
