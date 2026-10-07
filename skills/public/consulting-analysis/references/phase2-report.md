# Phase 2: Report Generation

## Purpose

Receive the completed **Analysis Framework** and **Data Package** from upstream, and synthesize them into a final consulting-grade report.

## Phase 2 Inputs

| Input                        | Description                                                                                                                      | Required |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Analysis Framework**       | The framework document produced in Phase 1                                                                                       | Yes      |
| **Data Summary**             | Collected data organized per chapter from the data collection phase                                                              | Yes      |
| **Chart Files**              | Local file paths for generated chart images. If not provided, will be generated in Step 2.3 using available visualization skills | Optional |
| **External Search Findings** | URLs and summaries for inline citations                                                                                          | Optional |

## Phase 2 Workflow

### Step 2.1: Receive and Validate Inputs

Verify that all required inputs are present:

1. **Analysis Framework** — Confirm it contains chapter skeleton, data requirements, and visualization plans
2. **Data Summary** — Confirm it contains data organized per chapter, cross-reference against P0 requirements
3. **Chart Files** — Confirm file paths are valid local paths

If any P0 data is missing, note it in the report and flag for the user.

### Step 2.2: Map Report Structure

Map the final report structure from the Analysis Framework:

1. **Abstract** — Executive summary with key takeaways
2. **Introduction** — Background, objectives, methodology
3. **Main Body Chapters (2...N)** — Mapped from the Framework's chapter skeleton
4. **Conclusion** — Pure, objective synthesis
5. **References** — GB/T 7714-2015 formatted references

### Step 2.3: Generate Chapter Charts (Pre-Report Visualization)

Before writing the report, generate all planned charts from the Analysis Framework's **Visualization & Content Plan**. This step ensures every sub-chapter has its "Visual Anchor" ready before narrative writing begins.

#### When to Execute This Step

- **Chart Files already provided**: Skip this step — proceed directly to Step 2.4.
- **Chart Files NOT provided but a visualization skill is available**: Execute this step to generate all charts first.
- **No Chart Files and no visualization skill available**: Skip this step — use comparison tables as the primary visual anchor in Step 2.4, and note the absence of charts.

#### Chart Generation Workflow

1. **Extract Chart Tasks**: Parse all `Visualization & Content Plan` entries from the Analysis Framework to build a chart generation task list:

| #   | Chapter | Chart Type | Chart Title                 | Data Mapping                          | Data Source             |
| --- | ------- | ---------- | --------------------------- | ------------------------------------- | ----------------------- |
| 1   | 2.1     | Line chart | Market Size Trend 2020-2025 | X: Year, Y: Market Size (billion CNY) | Data Requirement #1, #2 |
| 2   | 3.1     | Pie chart  | Consumer Age Distribution   | Segments: Age groups, Values: Share % | Data Requirement #5     |
| ... | ...     | ...        | ...                         | ...                                   | ...                     |

2. **Prepare Chart Data**: For each chart task, extract the corresponding data points from the **Data Summary**.

   > **CRITICAL**: Use ONLY the numbers provided in the Data Summary. Do NOT invent or "smooth" data to make charts look better. If data points are missing, the chart must reflect that reality (e.g., broken line or missing bar), or the chart type must be adjusted.

3. **Delegate to Visualization Skill**: Invoke the available visualization/charting skill (e.g., `data-analysis`) for each chart task with:
   - Chart type and title
   - Structured data
   - Axis labels and formatting preferences
   - Output file path convention: `charts/chapter_{N}_{chart_index}.png`

4. **Collect Chart File Paths**: Record all generated chart file paths for embedding in Step 2.4:

```markdown
## Generated Charts

| #   | Chapter | Chart Title                 | File Path              |
| --- | ------- | --------------------------- | ---------------------- |
| 1   | 2.1     | Market Size Trend 2020-2025 | charts/chapter_2_1.png |
| 2   | 3.1     | Consumer Age Distribution   | charts/chapter_3_1.png |
```

5. **Validate**: Confirm all P0-priority charts have been generated. If any chart generation fails, note it and fall back to comparison tables for that sub-chapter.

> **Principle**: Complete ALL chart generation before starting report writing. This ensures a consistent visual narrative and avoids interleaving generation with writing.

### Step 2.4: Write the Report

For each sub-chapter, follow the **"Visual Anchor → Data Contrast → Integrated Analysis"** flow:

1. **Visual Evidence Block**: Embed charts using `![Image Description](Actual_File_Path)` — use the file paths collected in Step 2.3
2. **Data Contrast Table**: Create a Markdown comparison table for key metrics
   > **Source Rule**: Every number in the table must come from the Data Summary. No hallucinations.
3. **Integrated Narrative Analysis**: Write analytical text following "What → Why → So What"
   > **Narrative Rule**: Narrative must explain the _provided_ data. Do not make claims unsupported by the inputs.

Each sub-chapter must end with a robust analytical paragraph (min. 200 words) that:

- Synthesizes conflicting or reinforcing data points
- Reveals the underlying user tension or opportunity
- Optionally ends with a punchy "One-Liner Truth" in a blockquote (`>`)

### Step 2.5: Final Structure Self-Check

Before outputting, confirm the report contains **all sections in order**:

```
Abstract → 1. Introduction → 2...N. Body Chapters → N+1. Conclusion → N+2. References
```

Additionally verify:

- All charts generated in Step 2.3 are embedded in the correct sub-chapters
- Chart file paths in `![](path)` references are valid
- Sub-chapters without charts have comparison tables as visual anchors

The report **MUST NOT** stop after the Conclusion — it **MUST** include References as the final section.

## Formatting & Tone Standards

### Consulting Voice

- **Tone**: McKinsey/BCG — Authoritative, Objective, Professional
- **Language**: All headings and content in the language specified by `output_locale`
- **Number Formatting**: Use English commas for thousands separators (`1,000` not `1，000`)
- **Data emphasis**: **Bold** important viewpoints and key numbers

### Titling Constraints

- **Numbering**: Use standard numbering (`1.`, `1.1`) directly followed by the title
- **Forbidden Prefixes**: Do NOT use "Chapter", "Part", "Section" as prefixes
- **Allowed Tone Words**: Analysis, Profiling, Overview, Insights, Assessment
- **Forbidden Words**: "Decoding", "DNA", "Secrets", "Mindscape", "Solar System", "Unlocking"

### Sub-Chapter Conclusions

- **Requirement**: End each sub-chapter with a robust analytical paragraph (min. 200 words).
- **Narrative Flow**: This paragraph must look like a natural continuation of the text. It must synthesize the section's findings into a strategic judgment.
- **Content Logic**:
  1.  Synthesize the conflicting or reinforcing data points above.
  2.  Reveal the _underlying_ user tension or opportunity.
  3.  Key Insight: **Optional**: Only if you have a concise, punchy "One-Liner Truth", place it at the very end using a **Blockquote** (`>`) to anchor the section.

### Insight Depth (The "So What" Chain)

Every insight must connect **Data → User Psychology → Strategy Implication**:

```
❌ Bad: "Females are 60%. Strategy: Target females."

✅ Good: "Females constitute 60% with a high TGI of 180. **This suggests**
   the purchase decision is driven by aesthetic and social validation
   rather than pure utility. **Consequently**, media spend should pivot
   towards visual-heavy platforms (e.g., RED/Instagram) to maximize CTR,
   treating male audiences only as a secondary gift-giving segment."
```

### References

- **Inline**: Use markdown links for sources (e.g. `[Source Title](URL)`) when using External Search Findings
- **References section**: Formatted strictly per **GB/T 7714-2015**

### Markdown Rules

- **Immediate Start**: Begin directly with `# Report Title` — no introductory text
- **No Separators**: Do NOT use horizontal rules (`---`)

## Phase 2 Quality Checklist (Final Report)

- [ ] **NO HALLUCINATION**: All numbers and charts are verified against the input Data Summary
- [ ] All planned charts generated before report writing (Step 2.3 completed first)
- [ ] All sections present in correct order (Abstract → Introduction → Body → Conclusion → References)
- [ ] Every sub-chapter follows "Visual Anchor → Data Contrast → Integrated Analysis"
- [ ] Every sub-chapter ends with a min. 200-word analytical paragraph
- [ ] All insights follow the "Data → User Psychology → Strategy Implication" chain
- [ ] All headings use proper numbering (no "Chapter/Part/Section" prefixes)
- [ ] Charts are embedded with `![Description](path)` syntax
- [ ] Numbers use English commas for thousands separators
- [ ] Inline references use markdown links where applicable
- [ ] References section follows GB/T 7714-2015
- [ ] No horizontal rules (`---`) in the document
- [ ] Conclusion uses flowing prose — no bullet points
- [ ] Report starts directly with `#` title — no preamble
- [ ] Missing P0 data is explicitly flagged in the report
