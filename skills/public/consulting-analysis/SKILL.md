---
name: consulting-analysis
description: Use this skill when the user requests a professional consulting-grade research report — market analysis, consumer insights, brand strategy, financial analysis, industry research, competitive intelligence, investment due diligence, or macroeconomic analysis (e.g., 市场分析、行业研究、投资尽调、竞品分析、用户洞察、财务分析、估值分析). It operates in two phases — (1) generate a structured analysis framework with chapter skeleton, data query requirements, and analysis logic, and (2) after data collection, synthesize inputs into a McKinsey/BCG-style report with charts, comparison tables, and strategic insights.
---

# Professional Research Report Skill

## Overview

This skill produces professional, consulting-grade research reports in Markdown format, covering domains such as **market analysis, consumer insights, brand strategy, financial analysis, industry research, competitive intelligence, investment research, and macroeconomic analysis**. It operates across two distinct phases:

1. **Phase 1 — Analysis Framework Generation**: Given a research subject, produce a rigorous analysis framework including chapter skeleton, per-chapter data requirements, analysis logic, and visualization plan.
2. **Phase 2 — Report Generation**: After data has been collected by other skills, synthesize all inputs into a final polished report.

The output adheres to McKinsey/BCG consulting voice standards. The report language follows the `output_locale` setting (default: `zh_CN` for Chinese).

## Data Authenticity Protocol

**Strict Adherence Rule**: All data presented in the report and visualized in charts MUST be derived directly from the provided **Data Summary** or **External Search Findings**.

- **NO Hallucinations**: Do not invent, estimate, or simulate data. If data is missing, state "Data not available" rather than fabricating numbers.
- **Traceable Sources**: Every major claim and chart must be traceable back to the input data package.

## Core Capabilities

- **Design analysis frameworks** from scratch given only a research subject and scope
- Transform raw data into structured, high-depth research reports
- Follow the **"Visual Anchor → Data Contrast → Integrated Analysis"** flow per sub-chapter
- Produce insights following the **"Data → User Psychology → Strategy Implication"** chain
- Embed pre-generated charts and construct comparison tables
- Generate inline citations formatted per **GB/T 7714-2015** standards
- Output reports in the language specified by `output_locale` with professional consulting tone
- Adapt analytical depth and structure to domain (marketing, finance, industry, etc.)

## When to Use This Skill

**Always load this skill when:**

- User asks for a market analysis, consumer insight report, financial analysis, industry research, or any consulting-grade analytical report
- User provides a research subject and needs a structured analysis framework before data collection
- User provides data summaries, analysis frameworks, or chart files to be synthesized into a report
- User needs a professional consulting-style research report
- The task involves transforming research findings into structured strategic narratives

## Two-Phase Workflow (Summary)

1. **Phase 1 — Framework**: Produce the analysis framework (chapter skeleton, per-chapter data requirements, visualization plan). Read `references/phase1-framework.md` for the full workflow before generating one.
2. **Handoff — Data Collection**: Other skills (e.g., deep-research) execute the Data Collection Task List and return a **Data Package** (Data Summary + chart files + source URLs). **This skill does NOT perform data collection** — it only produces the framework (Phase 1) and the final report (Phase 2). Chart generation can be deferred to the beginning of Phase 2 if a visualization skill is available.
3. **Phase 2 — Report**: Synthesize framework + Data Package into the final report. Read `references/phase2-report.md` for the writing workflow and tone standards before writing.

## Reference Guide

Read references on demand, only when the corresponding step begins:

- `references/phase1-framework.md` — Phase 1 full workflow (Steps 1.1–1.6), the complete framework library with selection principles, all output templates, and the Phase 1 quality checklist.
- `references/phase2-report.md` — Phase 2 full workflow (Steps 2.1–2.5), chart generation handoff, formatting & tone standards (consulting voice, titling constraints, "So What" chain, citation rules), and the Phase 2 quality checklist.
- `references/report-structure-template.md` — the report skeleton template (Abstract → Introduction → Body → Conclusion → References) with per-section writing guidance.
- `references/complete-example.md` — worked Phase 1 framework example and Phase 2 report outline for "Gen-Z Skincare Market Analysis".

## Output Format

- **Phase 1**: Output the complete Analysis Framework in **Markdown** format
- **Phase 2**: Output the complete Report in **Markdown** format

## Settings

```
output_locale = zh_CN  # configurable per user request
reasoning_locale = en
```

## Notes

- Dynamic titling: **Rewrite** topics from the Framework into professional, concise subject-based headers
- The Conclusion section must contain **NO** detailed recommendations — those belong in the preceding body chapters
- **ZERO HALLUCINATION POLICY**: Each statement, chart, and number in the report must be supported by data points from the input Data Summary. If data is missing, admit it.
- **Traceability**: If requested, you must be able to point to the specific line in the Data Summary or External Search Findings that supports a claim.
- The framework should adapt its analytical dimensions and depth to the specific domain (financial analysis uses different frameworks than consumer insights)
- When the research subject is ambiguous, default to the broadest reasonable scope and note assumptions
