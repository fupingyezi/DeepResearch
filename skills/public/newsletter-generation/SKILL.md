---
name: newsletter-generation
description: Use this skill when the user requests to generate, create, write, or draft a newsletter, email digest, weekly roundup, industry briefing, or curated content summary (e.g., 写一份 newsletter、生成行业简报、做个周报汇总、create a newsletter about X、write a weekly digest、generate a tech roundup、curate news about Y). Supports topic-based research, content curation from multiple sources, and professional formatting for email or web distribution.
---

# Newsletter Generation Skill

## Overview

This skill generates professional, well-researched newsletters that combine curated content from multiple sources with original analysis and commentary. It follows modern newsletter best practices from publications like Morning Brew, The Hustle, TLDR, and Benedict Evans to produce content that is informative, engaging, and actionable.

The output is a complete, ready-to-publish newsletter in Markdown format, suitable for email distribution platforms, web publishing, or conversion to HTML.

## Core Capabilities

- Research and curate content from multiple web sources on specified topics
- Generate topic-focused or multi-topic newsletters with consistent voice
- Write engaging headlines, summaries, and original commentary
- Structure content for optimal readability and scanning
- Support multiple newsletter formats (daily digest, weekly roundup, deep-dive, industry briefing)
- Include relevant links, sources, and attributions
- Adapt tone and style to target audience (technical, executive, general)
- Generate recurring newsletter series with consistent branding and structure

## When to Use This Skill

**Always load this skill when:**

- User asks to generate a newsletter, email digest, or content roundup
- User requests a curated summary of news or developments on a topic
- User wants to create a recurring newsletter format
- User asks to compile recent developments in a field into a briefing
- User needs a formatted email-ready content piece with multiple curated items
- User asks for a "weekly roundup", "monthly digest", or "morning briefing"

## Workflow Summary (Four Phases)

1. **Phase 1 — Planning**: Determine topic/format/audience/tone/length, select the structure (daily digest / weekly roundup / deep-dive / industry briefing).
2. **Phase 2 — Research & Curation**: Multi-source web search with time-aware queries, source evaluation (recency/authority/uniqueness), deep extraction via `web_fetch` for key stories.
3. **Phase 3 — Writing**: Header → section writing guidelines (top stories / quick bites / analysis) → writing standards with audience tone calibration.
4. **Phase 4 — Assembly & Polish**: Assemble per structure, add footer, run the quality checklist.

Read `references/workflow.md` for the full four-phase workflow, writing standards, and quality checklist; read `references/templates-and-examples.md` for the output template and per-domain adaptation examples.

## Output Handling

After generation:

- Save the newsletter to `/mnt/user-data/outputs/newsletter-{topic}-{date}.md`
- Present the newsletter to the user using the `present_files` tool
- Offer to adjust sections, tone, length, or focus areas
- If the user wants HTML output, note that the Markdown can be converted using standard tools

## Notes

- This skill works best in combination with the `deep-research` skill for comprehensive topic coverage — load both for newsletters requiring deep analysis
- Always use `<current_date>` for temporal context in searches and date references in the newsletter
- For recurring newsletters, suggest maintaining a consistent structure so readers develop expectations
- When curating, quality beats quantity — 5 excellent items beat 15 mediocre ones
- Attribute all content properly — newsletters build trust through transparent sourcing
- Avoid summarizing paywalled content that the reader cannot access
- If the user provides specific URLs or articles to include, incorporate them alongside your curated findings
- The newsletter should provide enough value in the summaries that readers benefit even without clicking through to every link
