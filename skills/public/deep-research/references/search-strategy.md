# Search Strategy

## Effective Query Patterns

```
# Be specific with context
❌ "AI trends"
✅ "enterprise AI adoption trends 2024"

# Include authoritative source hints
"[topic] research paper"
"[topic] McKinsey report"
"[topic] industry analysis"

# Search for specific content types
"[topic] case study"
"[topic] statistics"
"[topic] expert interview"

# Use temporal qualifiers — always use the ACTUAL current year from <current_date>
"[topic] 2026"   # ← replace with real current year, never hardcode a past year
"[topic] latest"
"[topic] recent developments"
```

## Temporal Awareness

**Always check `<current_date>` in your context before forming ANY search query.**

`<current_date>` gives you the full date: year, month, day, and weekday (e.g. `2026-02-28, Saturday`). Use the right level of precision depending on what the user is asking:

| User intent                            | Temporal precision needed | Example query                               |
| -------------------------------------- | ------------------------- | ------------------------------------------- |
| "today / this morning / just released" | **Month + Day**           | `"tech news February 28 2026"`              |
| "this week"                            | **Week range**            | `"technology releases week of Feb 24 2026"` |
| "recently / latest / new"              | **Month**                 | `"AI breakthroughs February 2026"`          |
| "this year / trends"                   | **Year**                  | `"software trends 2026"`                    |

**Rules:**

- When the user asks about "today" or "just released", use **month + day + year** in your search queries to get same-day results
- Never drop to year-only when day-level precision is needed — `"tech news 2026"` will NOT surface today's news
- Try multiple phrasings: numeric form (`2026-02-28`), written form (`February 28 2026`), and relative terms (`today`, `this week`) across different queries

❌ User asks "what's new in tech today" → searching `"new technology 2026"` → misses today's news
✅ User asks "what's new in tech today" → searching `"new technology February 28 2026"` + `"tech news today Feb 28"` → gets today's results

## When to Use web_fetch

Use `web_fetch` to read full content when:

- A search result looks highly relevant and authoritative
- You need detailed information beyond the snippet
- The source contains data, case studies, or expert analysis
- You want to understand the full context of a finding

## Iterative Refinement

Research is iterative. After initial searches:

1. Review what you've learned
2. Identify gaps in your understanding
3. Formulate new, more targeted queries
4. Repeat until you have comprehensive coverage
