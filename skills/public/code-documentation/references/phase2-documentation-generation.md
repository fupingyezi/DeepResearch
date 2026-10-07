# Phase 2: Documentation Generation

## Step 2.1: README Generation

Every project needs a README. Follow this structure:

```markdown
# Project Name

[One-line project description — what it does and why it matters]

[![Badge](link)](#) [![Badge](link)](#)

## Features

- [Key feature 1 — brief description]
- [Key feature 2 — brief description]
- [Key feature 3 — brief description]

## Quick Start

### Prerequisites

- [Prerequisite 1 with version requirement]
- [Prerequisite 2 with version requirement]

### Installation

[Installation commands with copy-paste-ready code blocks]

### Basic Usage

[Minimal working example that demonstrates core functionality]

## Documentation

- [Link to full API reference if separate]
- [Link to architecture docs if separate]
- [Link to examples directory if applicable]

## API Reference

[Inline API reference for smaller projects OR link to generated docs]

## Configuration

[Environment variables, config files, or runtime options]

## Examples

[2-3 practical examples covering common use cases]

## Development

### Setup

[How to set up a development environment]

### Testing

[How to run tests]

### Building

[How to build the project]

## Contributing

[Contribution guidelines or link to CONTRIBUTING.md]

## License

[License information]
```

## Step 2.2: API Reference Generation

For each public API surface, document:

**Function / Method Documentation**:

```markdown
### `functionName(param1, param2, options?)`

Brief description of what this function does.

**Parameters:**

| Parameter         | Type     | Required | Default | Description             |
| ----------------- | -------- | -------- | ------- | ----------------------- |
| `param1`          | `string` | Yes      | —       | Description of param1   |
| `param2`          | `number` | Yes      | —       | Description of param2   |
| `options`         | `Object` | No       | `{}`    | Configuration options   |
| `options.timeout` | `number` | No       | `5000`  | Timeout in milliseconds |

**Returns:** `Promise<Result>` — Description of return value

**Throws:**

- `ValidationError` — When param1 is empty
- `TimeoutError` — When the operation exceeds the timeout

**Example:**

\`\`\`javascript
const result = await functionName("hello", 42, { timeout: 10000 });
console.log(result.data);
\`\`\`
```

**Class Documentation**:

```markdown
### `ClassName`

Brief description of the class and its purpose.

**Constructor:**

\`\`\`javascript
new ClassName(config)
\`\`\`

| Parameter        | Type      | Description |
| ---------------- | --------- | ----------- |
| `config.option1` | `string`  | Description |
| `config.option2` | `boolean` | Description |

**Methods:**

- [`method1()`](#method1) — Brief description
- [`method2(param)`](#method2) — Brief description

**Properties:**

| Property    | Type     | Description            |
| ----------- | -------- | ---------------------- |
| `property1` | `string` | Description            |
| `property2` | `number` | Read-only. Description |
```

## Step 2.3: Architecture Documentation

For medium-to-large projects, include architecture documentation:

```markdown
# Architecture Overview

## System Diagram

[Include a Mermaid diagram showing the high-level architecture]

\`\`\`mermaid
graph TD
A[Client] --> B[API Gateway]
B --> C[Service A]
B --> D[Service B]
C --> E[(Database)]
D --> E
\`\`\`

## Component Overview

### Component Name

- **Purpose**: What this component does
- **Location**: `src/components/name/`
- **Dependencies**: What it depends on
- **Public API**: Key exports or interfaces

## Data Flow

[Describe how data flows through the system for key operations]

## Design Decisions

### Decision Title

- **Context**: What situation led to this decision
- **Decision**: What was decided
- **Rationale**: Why this approach was chosen
- **Trade-offs**: What was sacrificed
```

## Step 2.4: Inline Code Documentation

Generate language-appropriate inline documentation:

**Python (Docstrings — Google style)**:

```python
def process_data(input_path: str, options: dict | None = None) -> ProcessResult:
    """Process data from the given file path.

    Reads the input file, applies transformations based on the provided
    options, and returns a structured result object.

    Args:
        input_path: Absolute path to the input data file.
            Supports CSV, JSON, and Parquet formats.
        options: Optional configuration dictionary.
            - "validate" (bool): Enable input validation. Defaults to True.
            - "format" (str): Output format ("json" or "csv"). Defaults to "json".

    Returns:
        A ProcessResult containing the transformed data and metadata.

    Raises:
        FileNotFoundError: If input_path does not exist.
        ValidationError: If validation is enabled and data is malformed.

    Example:
        >>> result = process_data("/data/input.csv", {"validate": True})
        >>> print(result.row_count)
        1500
    """
```

**TypeScript (JSDoc / TSDoc)**:

````typescript
/**
 * Fetches user data from the API and transforms it for display.
 *
 * @param userId - The unique identifier of the user
 * @param options - Configuration options for the fetch operation
 * @param options.includeProfile - Whether to include the full profile. Defaults to `false`.
 * @param options.cache - Cache duration in seconds. Set to `0` to disable.
 * @returns The transformed user data ready for rendering
 * @throws {NotFoundError} When the user ID does not exist
 * @throws {NetworkError} When the API is unreachable
 *
 * @example
 * ```ts
 * const user = await fetchUser("usr_123", { includeProfile: true });
 * console.log(user.displayName);
 * ```
 */
````

**Go (GoDoc)**:

```go
// ProcessData reads the input file at the given path, applies the specified
// transformations, and returns the processed result.
//
// The input path must be an absolute path to a CSV or JSON file.
// If options is nil, default options are used.
//
// ProcessData returns an error if the file does not exist or cannot be parsed.
func ProcessData(inputPath string, options *ProcessOptions) (*Result, error) {
```
