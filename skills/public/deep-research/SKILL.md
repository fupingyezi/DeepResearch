---
name: deep-research
description: Use this skill instead of WebSearch for ANY question requiring web research. Trigger on queries like "what is X", "explain X", "compare X and Y", "research X", 调研一下、研究一下、查一下, or before content generation tasks. Provides systematic multi-angle research methodology instead of single superficial searches. Use this proactively when the user's question needs online information.
---

# Deep Research Skill

## Overview

This skill provides a systematic methodology for conducting thorough web research. **Load this skill BEFORE starting any content generation task** to ensure you gather sufficient information from multiple angles, depths, and sources.

## When to Use This Skill

**Always load this skill when:**

### Research Questions

- User asks "what is X", "explain X", "research X", "investigate X"
- User wants to understand a concept, technology, or topic in depth
- The question requires current, comprehensive information from multiple sources
- A single web search would be insufficient to answer properly

### Content Generation (Pre-research)

- Creating presentations (PPT/slides)
- Creating frontend designs or UI mockups
- Writing articles, reports, or documentation
- Producing videos or multimedia content
- Any content that requires real-world information, examples, or current data

## Core Principle

**Never generate content based solely on general knowledge.** The quality of your output directly depends on the quality and quantity of research conducted beforehand. A single search query is NEVER enough.

## Research Methodology (Four Phases)

1. **Broad Exploration**: Survey the main topic, identify key subtopics/angles from initial results, map the territory (perspectives, stakeholders, viewpoints).
2. **Deep Dive**: For each important dimension — targeted searches with multiple phrasings, `web_fetch` to read key sources in full, follow references mentioned in sources.
3. **Diversity & Validation**: Cover all information types — facts & data, examples & cases, expert opinions, trends & predictions, comparisons, challenges & criticisms.
4. **Synthesis Check**: Verify before generating content: ≥3-5 angles searched? Key sources read in full? Concrete data/examples/expert views? Both positives and limitations covered? Information current and authoritative? **If any answer is NO, keep researching.**

Read `references/search-strategy.md` for effective query patterns, temporal precision rules (`<current_date>` → month+day for "today" queries), when to use `web_fetch`, and iterative refinement. Read `references/quality-and-mistakes.md` for the research quality bar and common mistakes.

## Output

After completing research, you should have:

1. A comprehensive understanding of the topic from multiple angles
2. Specific facts, data points, and statistics
3. Real-world examples and case studies
4. Expert perspectives and authoritative sources
5. Current trends and relevant context

**Only then proceed to content generation**, using the gathered information to create high-quality, well-informed content.
