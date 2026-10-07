---
name: academic-paper-review
description: Use this skill when the user requests to review, analyze, critique, or summarize academic papers, research articles, preprints, or scientific publications (e.g., 审稿、论文评审、评价这篇论文、review this paper, analyze this research, summarize this study, write a peer review). Supports comprehensive structured reviews covering methodology assessment, contribution evaluation, literature positioning, and constructive feedback generation. Trigger on queries involving paper URLs, uploaded PDFs, or arXiv links.
---

# Academic Paper Review Skill

## Overview

This skill produces structured, peer-review-quality analyses of academic papers and research publications. It follows established academic review standards used by top-tier venues (NeurIPS, ICML, ACL, Nature, IEEE) to provide rigorous, constructive, and balanced assessments.

The review covers **summary, strengths, weaknesses, methodology assessment, contribution evaluation, literature positioning, and actionable recommendations** — all grounded in evidence from the paper itself.

## Core Capabilities

- Parse and comprehend academic papers from uploaded PDFs or fetched URLs
- Generate structured reviews following top-venue review templates
- Assess methodology rigor (experimental design, statistical validity, reproducibility)
- Evaluate novelty and significance of contributions
- Position the work within the broader research landscape via targeted literature search
- Produce both detailed review and concise executive summary formats
- Support papers in any scientific domain (CS, biology, physics, social sciences, etc.)

## When to Use This Skill

**Always load this skill when:**

- User provides a paper URL (arXiv, DOI, conference proceedings, journal link)
- User uploads a PDF of a research paper or preprint
- User asks to "review", "analyze", "critique", "assess", or "summarize" a research paper
- User requests a peer-review-style evaluation of academic work
- User asks for help preparing a review for a conference or journal submission

## Workflow Summary (Three Phases)

1. **Phase 1 — Paper Comprehension**: Identify metadata (title/authors/venue/type), read systematically (abstract → related work → methodology → results → limitations → conclusion), extract key claims with evidence. Read `references/review-methodology.md` for the full phase details.
2. **Phase 2 — Critical Analysis**: Literature context search via web, methodology assessment (6-criterion 1-5 rating table), contribution significance level, strengths & weaknesses analysis. Read `references/review-methodology.md` for assessment frameworks and review principles (constructive criticism / objectivity / ethics).
3. **Phase 3 — Review Synthesis**: Assemble the structured review. Read `references/review-template.md` for the full output template, adaptation guidance by paper type, and the final quality checklist.

## Output Format

- Output the complete review in **Markdown** format following the template in `references/review-template.md`
- Save the review to `/mnt/user-data/outputs/review-{paper-topic}.md` when working in sandbox
- Present the review to the user using the `present_files` tool

## Notes

- This skill complements the `deep-research` skill — load both when the user wants the paper reviewed in the context of the broader field
- For papers behind paywalls, work with whatever content is accessible (abstract, publicly available versions, preprint mirrors)
- Adapt the review depth to the user's needs: a brief assessment for quick triage versus a full review for submission preparation
- When reviewing multiple papers comparatively, maintain consistent criteria across all reviews
- Always disclose limitations of your review (e.g., "I could not verify the proofs in Appendix B in detail")
